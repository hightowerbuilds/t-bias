//! macOS collector. libproc is shipped in the SDK but carries compatibility
//! caveats; see the backend decision in the Activity Monitor roadmap.
use super::model::{Identity, Process, SystemSample};
use std::{
    collections::HashMap,
    ffi::CStr,
    mem::{size_of, zeroed},
    time::Instant,
};

// These Mach C functions are in the system library but not bound by libc 0.2.186.
extern "C" {
    fn mach_port_deallocate(
        task: libc::mach_port_t,
        name: libc::mach_port_t,
    ) -> libc::kern_return_t;
}
pub struct Raw {
    pub processes: Vec<Process>,
    pub system: SystemSample,
    pub ticks: Option<[u32; 4]>,
    pub unavailable: usize,
    pub error: Option<String>,
}
pub struct Backend {
    host: libc::mach_port_t,
    owners: HashMap<u32, String>,
    pub nanos_per_tick: f64,
    total: Option<u64>,
    page_size: u64,
}
impl Backend {
    pub fn new() -> Self {
        // SAFETY: all pointers refer to initialized, correctly sized C POD.
        #[allow(deprecated)]
        unsafe {
            let mut timebase: libc::mach_timebase_info = zeroed();
            let ok = libc::mach_timebase_info(&mut timebase) == 0 && timebase.denom > 0;
            let mut total = 0u64;
            let mut len = size_of::<u64>();
            let memory = libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                &mut total as *mut _ as *mut _,
                &mut len,
                std::ptr::null_mut(),
                0,
            );
            Self {
                host: libc::mach_host_self(),
                owners: HashMap::new(),
                nanos_per_tick: if ok {
                    timebase.numer as f64 / timebase.denom as f64
                } else {
                    f64::NAN
                },
                total: (memory == 0 && len == size_of::<u64>()).then_some(total),
                page_size: libc::sysconf(libc::_SC_PAGESIZE).max(0) as u64,
            }
        }
    }
    pub fn sample(&mut self) -> Raw {
        let (system, ticks) = self.system();
        let mut raw = Raw {
            processes: vec![],
            system,
            ticks,
            unavailable: 0,
            error: None,
        };
        let pids = match inventory() {
            Ok(p) => p,
            Err(e) => {
                raw.error = Some(format!("Process inventory unavailable: {e}"));
                return raw;
            }
        };
        for pid in pids {
            let (bsd, task) =
                if let Some(all) = info::<libc::proc_taskallinfo>(pid, libc::PROC_PIDTASKALLINFO) {
                    (all.pbsd, Some(all.ptinfo))
                } else if let Some(bsd) = info::<libc::proc_bsdinfo>(pid, libc::PROC_PIDTBSDINFO) {
                    (bsd, None)
                } else {
                    raw.unavailable += 1;
                    continue;
                };
            if bsd.pbi_pid != pid as u32 {
                raw.unavailable += 1;
                continue;
            }
            let name = cchars(&bsd.pbi_name);
            let name = if name.is_empty() {
                cchars(&bsd.pbi_comm)
            } else {
                name
            };
            let owner = self
                .owners
                .entry(bsd.pbi_uid)
                .or_insert_with(|| owner_name(bsd.pbi_uid))
                .clone();
            if task.is_none() {
                raw.unavailable += 1;
            }
            raw.processes.push(Process {
                id: identity(&bsd),
                parent: bsd.pbi_ppid as i32,
                uid: bsd.pbi_uid,
                owner,
                name,
                // BSD SRUN does not mean every thread is executing on a core.
                state: match bsd.pbi_status {
                    1 => "Starting",
                    2 => "Sleeping",
                    3 => "Runnable",
                    4 => "Stopped",
                    5 => "Zombie",
                    _ => "Unknown",
                }
                .into(),
                cpu: None,
                rss: task.as_ref().map(|t| t.pti_resident_size),
                threads: task
                    .as_ref()
                    .and_then(|t| u32::try_from(t.pti_threadnum).ok()),
                cpu_ticks: task
                    .as_ref()
                    .and_then(|t| t.pti_total_user.checked_add(t.pti_total_system)),
                sampled: Instant::now(),
                shell: None,
            });
        }
        self.owners
            .retain(|uid, _| raw.processes.iter().any(|p| p.uid == *uid));
        raw
    }
    fn system(&self) -> (SystemSample, Option<[u32; 4]>) {
        let mut sample = SystemSample {
            memory_total: self.total,
            ..Default::default()
        };
        // The kernel writes at most the supplied count. Require the complete
        // SDK revision used here before reading VM fields; never fake zeroes.
        unsafe {
            let mut cpu: libc::host_cpu_load_info = zeroed();
            let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
            let ok = libc::host_statistics(
                self.host,
                libc::HOST_CPU_LOAD_INFO,
                &mut cpu as *mut _ as *mut _,
                &mut count,
            ) == 0
                && count == libc::HOST_CPU_LOAD_INFO_COUNT;
            let mut vm: libc::vm_statistics64 = zeroed();
            let mut vm_count = libc::HOST_VM_INFO64_COUNT;
            if libc::host_statistics64(
                self.host,
                libc::HOST_VM_INFO64,
                &mut vm as *mut _ as *mut _,
                &mut vm_count,
            ) == 0
                && vm_count >= libc::HOST_VM_INFO64_COUNT
                && self.page_size > 0
            {
                sample.memory_active = Some(vm.active_count as u64 * self.page_size);
                sample.memory_wired = Some(vm.wire_count as u64 * self.page_size);
                sample.memory_compressed = Some(vm.compressor_page_count as u64 * self.page_size);
                sample.memory_free = Some(vm.free_count as u64 * self.page_size);
            }
            (sample, ok.then_some(cpu.cpu_ticks))
        }
    }
}
impl Drop for Backend {
    #[allow(deprecated)]
    fn drop(&mut self) {
        unsafe {
            mach_port_deallocate(libc::mach_task_self(), self.host);
        }
    }
}
fn inventory() -> std::io::Result<Vec<i32>> {
    // proc_listallpids returns a PID count, not a byte count. Retry a full
    // buffer for process churn, with a bound on both allocation and retries.
    let estimate = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if estimate <= 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut capacity = (estimate as usize + 128).min(131072);
    for _ in 0..4 {
        let mut pids = vec![0i32; capacity];
        let n = unsafe {
            libc::proc_listallpids(
                pids.as_mut_ptr().cast(),
                (capacity * size_of::<i32>()) as i32,
            )
        };
        if n <= 0 {
            return Err(std::io::Error::last_os_error());
        }
        if (n as usize) < capacity {
            pids.truncate(n as usize);
            pids.retain(|p| *p >= 0);
            pids.sort_unstable();
            pids.dedup();
            return Ok(pids);
        }
        capacity = (capacity * 2).min(131072);
    }
    Err(std::io::Error::other(
        "process inventory changed too quickly; retrying next sample",
    ))
}
// Only called with the matching C POD type/flavor by this module.
fn info<T>(pid: i32, flavor: i32) -> Option<T> {
    unsafe {
        let mut data: std::mem::MaybeUninit<T> = std::mem::MaybeUninit::zeroed();
        let n = libc::proc_pidinfo(
            pid,
            flavor,
            0,
            data.as_mut_ptr().cast(),
            size_of::<T>() as i32,
        );
        (n == size_of::<T>() as i32).then(|| data.assume_init())
    }
}
fn identity(b: &libc::proc_bsdinfo) -> Identity {
    Identity {
        pid: b.pbi_pid as i32,
        seconds: b.pbi_start_tvsec,
        micros: b.pbi_start_tvusec,
    }
}
fn cchars(s: &[libc::c_char]) -> String {
    let bytes: Vec<_> = s
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    String::from_utf8_lossy(&bytes)
        .chars()
        .map(|c| if c.is_control() { '�' } else { c })
        .collect()
}
fn owner_name(uid: u32) -> String {
    unsafe {
        let mut pwd: libc::passwd = zeroed();
        let mut result = std::ptr::null_mut();
        let mut buffer = vec![0u8; 32768];
        if libc::getpwuid_r(
            uid,
            &mut pwd,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        ) == 0
            && !result.is_null()
            && !pwd.pw_name.is_null()
        {
            CStr::from_ptr(pwd.pw_name).to_string_lossy().into_owned()
        } else {
            uid.to_string()
        }
    }
}
pub fn executable(id: Identity) -> Option<String> {
    if identity(&info::<libc::proc_bsdinfo>(id.pid, libc::PROC_PIDTBSDINFO)?) != id {
        return None;
    }
    let mut path = [0i8; 4096];
    let n = unsafe { libc::proc_pidpath(id.pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if n <= 0 || identity(&info::<libc::proc_bsdinfo>(id.pid, libc::PROC_PIDTBSDINFO)?) != id {
        return None;
    }
    Some(cchars(&path))
}
