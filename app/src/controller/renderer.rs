//! Offscreen wgpu -> BGRA -> GPUI. GPU waits stay on a sleeping worker.
use anyhow::{Context as _, Result};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const WIDTH: u32 = 1000;
pub const HEIGHT: u32 = 580;
// Triangle, Circle, Cross, Square, Up, Down, Left, Right, L1, R1,
// L2, R2, L3, R3, Start, Select. Shared by hit testing and the shader.
pub const CONTROLS: [[f32; 4]; 16] = [
    [730., 207., 24., 24.],
    [783., 260., 24., 24.],
    [730., 313., 24., 24.],
    [677., 260., 24., 24.],
    [270., 217., 17., 23.],
    [270., 303., 17., 23.],
    [227., 260., 23., 17.],
    [313., 260., 23., 17.],
    [265., 152., 48., 15.],
    [735., 152., 48., 15.],
    [265., 113., 43., 14.],
    [735., 113., 43., 14.],
    [385., 365., 43., 43.],
    [615., 365., 43., 43.],
    [551., 269., 22., 12.],
    [449., 269., 22., 12.],
];

#[derive(Clone, Debug, PartialEq)]
pub struct Scene {
    pub pressed: u32,
    pub supported: u32,
    pub selected: usize,
    pub hovered: Option<usize>,
    pub sticks: [f32; 4],
    pub width: u32,
}
impl Default for Scene {
    fn default() -> Self {
        Self {
            pressed: 0,
            supported: 0xffff,
            selected: 0,
            hovered: None,
            sticks: [0.; 4],
            width: WIDTH,
        }
    }
}
pub fn hit(x: f32, y: f32) -> Option<usize> {
    CONTROLS.iter().position(|[cx, cy, rx, ry]| {
        let dx = (x - cx) / (rx + 8.);
        let dy = (y - cy) / (ry + 8.);
        dx.abs() <= 1. && dy.abs() <= 1.
    })
}
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    viewport: [f32; 4],
    sticks: [f32; 4],
    geometry: [[f32; 4]; 16],
    flags: [[f32; 4]; 16],
}
pub struct Frame {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub adapter: String,
    pub milliseconds: f64,
}
pub struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    uniform: wgpu::Buffer,
    bind: wgpu::BindGroup,
    target: Option<(u32, wgpu::Texture, wgpu::Buffer)>,
    adapter: String,
}
impl Gpu {
    pub fn new() -> Result<Self> {
        pollster::block_on(async {
            let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
                backends: wgpu::Backends::METAL,
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            });
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::LowPower,
                    ..Default::default()
                })
                .await?;
            let name = format!(
                "{} · {:?}",
                adapter.get_info().name,
                adapter.get_info().backend
            );
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor {
                    label: Some("controller map"),
                    required_limits: wgpu::Limits::downlevel_defaults(),
                    ..Default::default()
                })
                .await?;
            let shader = device.create_shader_module(wgpu::include_wgsl!("controller.wgsl"));
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("controller illustration"),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vertex"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fragment"),
                    targets: &[Some(wgpu::TextureFormat::Bgra8Unorm.into())],
                    compilation_options: Default::default(),
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            });
            let uniform = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("controller state"),
                size: std::mem::size_of::<Uniforms>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipeline.get_bind_group_layout(0),
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                }],
            });
            Ok(Self {
                device,
                queue,
                pipeline,
                uniform,
                bind,
                target: None,
                adapter: name,
            })
        })
    }
    pub fn render(&mut self, scene: &Scene) -> Result<Frame> {
        let start = Instant::now();
        let width = scene.width.clamp(320, 1400);
        let height = width * HEIGHT / WIDTH;
        let stride = (width * 4).div_ceil(256) * 256;
        if self.target.as_ref().is_none_or(|t| t.0 != width) {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("controller offscreen"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Bgra8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("controller readback"),
                size: u64::from(stride * height),
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            self.target = Some((width, texture, buffer));
        }
        let flags = std::array::from_fn(|i| {
            [
                f32::from(scene.pressed & (1 << i) != 0),
                f32::from(scene.selected == i),
                f32::from(scene.hovered == Some(i)),
                f32::from(scene.supported & (1 << i) != 0),
            ]
        });
        self.queue.write_buffer(
            &self.uniform,
            0,
            bytemuck::bytes_of(&Uniforms {
                viewport: [width as f32, height as f32, 0., 0.],
                sticks: scene.sticks,
                geometry: CONTROLS,
                flags,
            }),
        );
        let (_, texture, buffer) = self.target.as_ref().unwrap();
        let view = texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("controller map"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = tx.send(result);
            });
        self.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(5)),
        })?;
        rx.recv_timeout(Duration::from_secs(1))??;
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        {
            let bytes = buffer.slice(..).get_mapped_range();
            for row in bytes.chunks(stride as usize) {
                pixels.extend_from_slice(&row[..(width * 4) as usize]);
            }
        }
        buffer.unmap();
        Ok(Frame {
            pixels,
            width,
            height,
            adapter: self.adapter.clone(),
            milliseconds: start.elapsed().as_secs_f64() * 1000.,
        })
    }
}

struct State {
    request: Option<Scene>,
    generation: u64,
    latest: Option<Result<Frame, String>>,
    shutdown: bool,
}
pub struct Renderer {
    shared: Arc<(Mutex<State>, Condvar)>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Renderer {
    pub fn new() -> Result<(Self, futures::channel::mpsc::Receiver<()>)> {
        let shared = Arc::new((
            Mutex::new(State {
                request: None,
                generation: 0,
                latest: None,
                shutdown: false,
            }),
            Condvar::new(),
        ));
        let copy = shared.clone();
        let (mut tx, rx) = futures::channel::mpsc::channel(1);
        let worker = std::thread::Builder::new()
            .name("tbias-controller-gpu".into())
            .spawn(move || {
                // Convert driver/validation panics into a usable UI error as well as Result errors.
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
                        let mut gpu = Gpu::new()?;
                        let mut processed = 0;
                        let mut next = Instant::now();
                        loop {
                            let (lock, changed) = &*copy;
                            let mut s = lock.lock().unwrap();
                            while !s.shutdown
                                && (s.request.is_none()
                                    || s.generation == processed
                                    || Instant::now() < next)
                            {
                                s = if s.request.is_some() && s.generation != processed {
                                    changed
                                        .wait_timeout(
                                            s,
                                            next.saturating_duration_since(Instant::now()),
                                        )
                                        .unwrap()
                                        .0
                                } else {
                                    changed.wait(s).unwrap()
                                };
                            }
                            if s.shutdown {
                                return Ok(());
                            }
                            let scene = s.request.clone().unwrap();
                            let generation = s.generation;
                            drop(s);
                            let started = Instant::now();
                            let frame = gpu.render(&scene)?;
                            let mut s = lock.lock().unwrap();
                            // Keep the latest completed frame during rapid input. Hidden views discard it.
                            if s.request.is_some() {
                                s.latest = Some(Ok(frame));
                                let _ = tx.try_send(());
                            }
                            processed = generation;
                            next = started + Duration::from_millis(33);
                        }
                    }));
                let error = match result {
                    Ok(Ok(())) => return,
                    Ok(Err(e)) => format!("{e:#}"),
                    Err(_) => "The graphics driver could not render the controller map".into(),
                };
                log::error!("controller renderer: {error}");
                copy.0.lock().unwrap().latest = Some(Err(error));
                let _ = tx.try_send(());
            })?;
        Ok((
            Self {
                shared,
                worker: Some(worker),
            },
            rx,
        ))
    }
    pub fn request(&self, scene: Option<Scene>) {
        let mut state = self.shared.0.lock().unwrap();
        if state.request != scene {
            state.request = scene;
            state.generation += 1;
            self.shared.1.notify_one();
        }
    }
    pub fn take(&self) -> Option<Result<Frame, String>> {
        self.shared.0.lock().unwrap().latest.take()
    }
}
impl Drop for Renderer {
    fn drop(&mut self) {
        self.shared.0.lock().unwrap().shutdown = true;
        self.shared.1.notify_one();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
pub fn probe(path: &str) -> Result<()> {
    let mut gpu = Gpu::new()?;
    let first = gpu.render(&Scene::default())?;
    let active = gpu.render(&Scene {
        pressed: 1 << 1,
        sticks: [0.6, -0.3, 0., 0.],
        selected: 1,
        ..Default::default()
    })?;
    anyhow::ensure!(
        first.pixels != active.pixels,
        "controller state did not change the rendered image"
    );
    let mut rgba = active.pixels;
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    image::save_buffer(
        path,
        &rgba,
        active.width,
        active.height,
        image::ColorType::Rgba8,
    )
    .context("saving GPU probe")?;
    println!(
        "CONTROLLER_GPU_OK: {} · {}x{} · {:.2} ms including readback · {}",
        first.adapter, active.width, active.height, active.milliseconds, path
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hit_testing_matches_every_rendered_control() {
        for (i, [x, y, _, _]) in CONTROLS.iter().enumerate() {
            assert_eq!(hit(*x, *y), Some(i));
        }
        assert_eq!(hit(0., 0.), None);
        assert_eq!(hit(500., 540.), None);
    }
}
