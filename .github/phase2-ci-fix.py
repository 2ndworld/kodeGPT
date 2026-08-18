from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCHES = [
    ROOT / ".github" / "phase2-ci-fix.patch",
    ROOT / ".github" / "phase2-packaging-fix.patch",
]


@dataclass
class FilePatch:
    path: Path
    hunks: list[list[str]] = field(default_factory=list)


def parse_patch(text: str) -> list[FilePatch]:
    lines = text.splitlines(keepends=True)
    patches: list[FilePatch] = []
    current: FilePatch | None = None
    current_hunk: list[str] | None = None
    for line in lines:
        if line.startswith("diff --git "):
            if current_hunk is not None and current is not None:
                current.hunks.append(current_hunk)
            current = None
            current_hunk = None
            continue
        if line.startswith("+++ "):
            raw = line.strip()[4:]
            if not raw.startswith("b/"):
                raise RuntimeError(f"unsupported patch target: {raw}")
            relative = Path(raw[2:])
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError(f"unsafe patch target: {relative}")
            current = FilePatch(ROOT / relative)
            patches.append(current)
            continue
        if line.startswith("@@"):
            if current is None:
                raise RuntimeError("hunk before target")
            if current_hunk is not None:
                current.hunks.append(current_hunk)
            current_hunk = []
            continue
        if current_hunk is not None:
            if line.startswith((" ", "+", "-")):
                current_hunk.append(line)
            elif line.startswith(("--- ", "index ", "\\ No newline")):
                continue
            else:
                raise RuntimeError(f"unsupported patch line: {line!r}")
    if current_hunk is not None and current is not None:
        current.hunks.append(current_hunk)
    return patches


def apply_patch(patch: FilePatch) -> None:
    relative = str(patch.path.relative_to(ROOT))
    content = patch.path.read_text(encoding="utf-8")
    cursor = 0
    for index, hunk in enumerate(patch.hunks, start=1):
        old = "".join(line[1:] for line in hunk if line.startswith((" ", "-")))
        new = "".join(line[1:] for line in hunk if line.startswith((" ", "+")))
        position = content.find(old, cursor)
        if position < 0:
            raise RuntimeError(f"hunk {index} not found after offset {cursor}: {relative}")
        content = content[:position] + new + content[position + len(old):]
        cursor = position + len(new)
    patch.path.write_text(content, encoding="utf-8")


def main() -> None:
    all_patches: list[FilePatch] = []
    for patch_path in PATCHES:
        parsed = parse_patch(patch_path.read_text(encoding="utf-8"))
        if not parsed:
            raise RuntimeError(f"CI fix patch is empty: {patch_path.name}")
        all_patches.extend(parsed)
    for patch in all_patches:
        apply_patch(patch)
        print(f"applied {patch.path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
