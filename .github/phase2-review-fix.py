from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCH = ROOT / ".github" / "phase2-review-fix.patch"


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
            current_hunk = None
            current = None
            continue
        if line.startswith("+++ "):
            raw = line.strip()[4:]
            if not raw.startswith("b/"):
                raise RuntimeError(f"unsupported target: {raw}")
            relative = Path(raw[2:])
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError(f"unsafe target: {relative}")
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
            elif line.startswith("\\ No newline"):
                continue
            elif line.startswith(("--- ", "index ")):
                continue
            else:
                raise RuntimeError(f"unsupported patch line: {line!r}")

    if current_hunk is not None and current is not None:
        current.hunks.append(current_hunk)
    return patches


def apply_patch(patch: FilePatch) -> None:
    relative = str(patch.path.relative_to(ROOT))
    if not patch.path.is_file():
        raise RuntimeError(f"missing target: {relative}")
    content = patch.path.read_text(encoding="utf-8")
    cursor = 0
    for index, hunk in enumerate(patch.hunks, start=1):
        old = "".join(line[1:] for line in hunk if line.startswith((" ", "-")))
        new = "".join(line[1:] for line in hunk if line.startswith((" ", "+")))
        if not old:
            raise RuntimeError(f"empty old text in hunk {index}: {relative}")
        position = content.find(old, cursor)
        if position < 0:
            raise RuntimeError(f"hunk {index} not found after offset {cursor}: {relative}")
        content = content[:position] + new + content[position + len(old):]
        cursor = position + len(new)
    patch.path.write_text(content, encoding="utf-8")


def main() -> None:
    patches = parse_patch(PATCH.read_text(encoding="utf-8"))
    if not patches:
        raise RuntimeError("review fix patch is empty")
    for patch in patches:
        apply_patch(patch)
        print(f"applied {patch.path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
