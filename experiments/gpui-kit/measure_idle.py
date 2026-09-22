#!/usr/bin/env python3
"""Small native-window observation, not a cross-workload performance benchmark."""
import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("binary", type=Path)
args = parser.parse_args()
binary = args.binary.resolve(strict=True)
data = Path(tempfile.mkdtemp(prefix="tbias-kit-measure-"))
environment = dict(os.environ, TBIAS_DATA_DIR=str(data))
with (data / "process.log").open("w") as log:
    process = subprocess.Popen([str(binary)], env=environment, stdout=log, stderr=log)
    try:
        print(f"Observing isolated window, PID {process.pid}", flush=True)
        time.sleep(5)
        samples = []
        for _ in range(10):
            if process.poll() is not None:
                raise RuntimeError(f"Window process exited: {process.returncode}; see {data}")
            cpu, rss = subprocess.check_output(
                ["ps", "-p", str(process.pid), "-o", "%cpu=,rss="], text=True
            ).split()
            samples.append({"ps_cpu_percent": float(cpu), "rss_kib": int(rss)})
            time.sleep(1)
        result = {
            "binary": str(binary),
            "data": str(data),
            "scenario": "fresh native window, 5s settle, 10 ps observations at 1s intervals",
            "median_ps_cpu_percent": statistics.median(s["ps_cpu_percent"] for s in samples),
            "median_rss_kib": statistics.median(s["rss_kib"] for s in samples),
            "samples": samples,
        }
        (data / "idle.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2), flush=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
