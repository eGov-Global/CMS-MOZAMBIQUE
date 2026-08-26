#!/usr/bin/env python3
"""Interactively pick env/profile/scenario and run run-test.sh.
Usage:
    python3 run-test-interactive.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
SCENARIOS_DIR = ROOT_DIR / "k6" / "scenarios"
PROFILES_DIR = ROOT_DIR / "profiles"
ENVIRONMENTS_FILE = ROOT_DIR / "k6" / "config" / "environments.js"
ENVIRONMENTS_EXAMPLE_FILE = ROOT_DIR / "k6" / "config" / "environments.js.example"
NON_SCENARIO_FILES = {"pgr-lifecycle"}

def list_scenarios():
    """Names of runnable k6 scenarios, excluding shared-logic modules."""
    names = (f.stem for f in sorted(SCENARIOS_DIR.glob("*.js")))
    return [name for name in names if name not in NON_SCENARIO_FILES]


def list_profiles():
    """Names of available CPU profiles."""
    return [f.stem for f in sorted(PROFILES_DIR.glob("*.yml"))]


def list_envs():
    """Names of configured target environments (ENVS keys)."""
    config_file = ENVIRONMENTS_FILE if ENVIRONMENTS_FILE.exists() else ENVIRONMENTS_EXAMPLE_FILE
    text = config_file.read_text()
    match = re.search(r"export const ENVS = \{(.*?)\n\};", text, re.DOTALL)
    return re.findall(r"^\s{2}(\w+):\s*\{", match.group(1), re.MULTILINE)

def prompt_choice(label, options):
    """Show a numbered list and return the chosen option, re-prompting on bad input."""
    print(f"\n{label}:")
    for i, option in enumerate(options, start=1):
        print(f"  {i}) {option}")

    while True:
        raw = input(f"Select {label.lower()} [1-{len(options)}]: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return options[int(raw) - 1]
        print(f"Invalid choice: {raw!r}")

def main():
    envs = list_envs()
    profiles = list_profiles()
    scenarios = list_scenarios()

    if not (envs and profiles and scenarios):
        print("No envs, profiles, or scenarios found — check the repo layout.")
        return 1

    env = prompt_choice("Environment", envs)
    profile = prompt_choice("CPU profile", profiles)
    scenario = prompt_choice("Scenario", scenarios)

    run_test_script = ROOT_DIR / "scripts" / "run-test.sh"
    return subprocess.run([str(run_test_script), env, profile, scenario]).returncode


if __name__ == "__main__":
    sys.exit(main())
