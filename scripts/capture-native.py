#!/usr/bin/env python3
"""Capture isolated development windows for human visual review (macOS desktop)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

repo = Path(__file__).resolve().parent.parent
binary = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else repo / 'app/target/debug/t-bias'
evidence = Path(tempfile.mkdtemp(prefix='tbias-appearance-'))
print(f'Appearance evidence: {evidence}', flush=True)
# WindowServer metadata only; screenshots are restricted to the process we start.
query = '''import AppKit
let pid = Int32(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in windows where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
 print(w[kCGWindowNumber as String] as! Int)
 break
}
'''
query_path = evidence / 'window.swift'
query_path.write_text(query)
for theme, surface, compact in [('dark', '--prompts', False), ('light', '--settings', True), ('dracula', '--activity-monitor', False)]:
    name = f'{theme}-{surface[2:]}'
    data = evidence / name
    data.mkdir()
    (data / 'config.toml').write_text(f'theme = "{theme}"\n')
    env = dict(os.environ, TBIAS_DATA_DIR=str(data))
    env.pop('TBIAS_CONFIG', None)
    with (data / 'startup.txt').open('w') as log:
        child = subprocess.Popen([str(binary), surface] + (['--compact'] if compact else []), env=env, stdout=log, stderr=log)
        try:
            time.sleep(3)
            if child.poll() is not None:
                raise RuntimeError(f'{name} exited early: {child.returncode}')
            window_id = subprocess.check_output(['swift', str(query_path), str(child.pid)], text=True).strip()
            if not window_id.isdigit():
                raise RuntimeError(f'No isolated window found for {name}')
            subprocess.run(['/usr/sbin/screencapture', '-x', '-l', window_id, str(evidence / f'{name}.png')], check=True)
            print(f'Captured {name}', flush=True)
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
print(json.dumps({'evidence': str(evidence)}))
