"""Pack contract: skill frontmatter, manifest agreement, and an engine that never launches a shell."""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

EXTENSION_KEY = "ai.insodimension.dimension"
SKILL_SPEC_KEYS = {"name", "description", "license", "allowed-tools", "metadata", "compatibility"}
TOP_LEVEL_KEY = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*):(.*)$")
BLOCK_SCALAR_INDICATORS = {">", ">-", ">+", "|", "|-", "|+"}
SHELL_ONLY_CALLS = {
    ("os", "system"),
    ("os", "popen"),
    ("subprocess", "getoutput"),
    ("subprocess", "getstatusoutput"),
}


def read_frontmatter(path: Path) -> dict[str, list[str]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines and lines[0].strip() == "---", f"{path.name} must open with a frontmatter fence"
    closing = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    assert closing is not None, f"{path.name} frontmatter is never closed"
    fields: dict[str, list[str]] = {}
    current = None
    for line in lines[1:closing]:
        match = TOP_LEVEL_KEY.match(line)
        if match:
            current = match.group(1)
            fields[current] = [match.group(2).strip()]
        elif current is not None and line.strip():
            fields[current].append(line.strip())
    return fields


def scalar(parts: list[str]) -> str:
    if parts[0] in BLOCK_SCALAR_INDICATORS:
        return " ".join(parts[1:])
    text = " ".join(part for part in parts if part)
    if len(text) >= 2 and text[0] == text[-1] == '"':
        return json.loads(text)
    if len(text) >= 2 and text[0] == text[-1] == "'":
        return text[1:-1].replace("''", "'")
    return text


def shell_launches(source: str, filename: str) -> list[str]:
    found = []
    for node in ast.walk(ast.parse(source, filename)):
        if not isinstance(node, ast.Call):
            continue
        for keyword in node.keywords:
            disabled = isinstance(keyword.value, ast.Constant) and keyword.value.value is False
            if keyword.arg == "shell" and not disabled:
                found.append(f"{filename}:{node.lineno}: shell={ast.unparse(keyword.value)}")
        func = node.func
        if (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and (func.value.id, func.attr) in SHELL_ONLY_CALLS
        ):
            found.append(f"{filename}:{node.lineno}: {func.value.id}.{func.attr}()")
    return found


@pytest.fixture
def skill_fields(pack_root):
    return read_frontmatter(pack_root / "skills" / "watch" / "SKILL.md")


@pytest.fixture
def plugin(pack_root):
    return json.loads((pack_root / "plugin.json").read_text(encoding="utf-8"))


@pytest.fixture
def package(pack_root):
    return json.loads((pack_root / "package.json").read_text(encoding="utf-8"))


def test_skill_frontmatter_uses_only_keys_from_the_agent_skills_spec(skill_fields):
    unknown = set(skill_fields) - SKILL_SPEC_KEYS

    assert not unknown, f"keys outside the Agent Skills spec: {sorted(unknown)}"


def test_skill_is_named_watch(skill_fields):
    assert scalar(skill_fields["name"]) == "watch"


def test_skill_description_fits_the_agent_skills_length_limit(skill_fields):
    description = scalar(skill_fields["description"])

    assert 1 <= len(description) <= 1024


def test_plugin_and_package_manifests_carry_the_same_version(plugin, package):
    assert plugin["version"] == package["version"]


def test_pack_ships_enabled_by_default(plugin):
    assert plugin["extensions"][EXTENSION_KEY]["defaultEnabled"] is True


def test_ffmpeg_is_the_only_command_the_user_must_install(plugin):
    requires = plugin["extensions"][EXTENSION_KEY]["connect"]["requires"]

    assert requires["commands"] == ["ffmpeg"]
    assert set(requires["install"]) == {"ffmpeg"}


def test_no_engine_script_launches_a_shell(pack_root):
    scripts = sorted((pack_root / "scripts").glob("*.py"))
    assert scripts, "no engine scripts found to scan"

    launches = [
        launch
        for script in scripts
        for launch in shell_launches(script.read_text(encoding="utf-8"), script.name)
    ]

    assert launches == []
