from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCHES = [
    ROOT / ".github" / "phase2-recovery.patch",
    ROOT / ".github" / "phase2-recovery-extra.patch",
]


@dataclass
class FilePatch:
    path: Path
    new_file: bool = False
    hunks: list[list[str]] = field(default_factory=list)


def parse_patch(text: str) -> list[FilePatch]:
    lines = text.splitlines(keepends=True)
    patches: list[FilePatch] = []
    current: FilePatch | None = None
    current_hunk: list[str] | None = None
    old_dev_null = False

    for line in lines:
        if line.startswith("diff --git "):
            if current_hunk is not None and current is not None:
                current.hunks.append(current_hunk)
            current_hunk = None
            current = None
            old_dev_null = False
            continue
        if line.startswith("--- "):
            old_dev_null = line.strip() == "--- /dev/null"
            continue
        if line.startswith("+++ "):
            raw = line.strip()[4:]
            if not raw.startswith("b/"):
                raise RuntimeError(f"unsupported patch target: {raw}")
            relative = Path(raw[2:])
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError(f"unsafe patch target: {relative}")
            current = FilePatch(ROOT / relative, new_file=old_dev_null)
            patches.append(current)
            continue
        if line.startswith("@@"):
            if current is None:
                raise RuntimeError("hunk appeared before target path")
            if current_hunk is not None:
                current.hunks.append(current_hunk)
            current_hunk = []
            continue
        if current_hunk is not None:
            if line.startswith((" ", "+", "-")):
                current_hunk.append(line)
            elif line.startswith("\\ No newline"):
                continue
            elif line.startswith(("new file mode ", "deleted file mode ", "index ")):
                continue
            else:
                raise RuntimeError(f"unsupported pseudo-patch line: {line!r}")

    if current_hunk is not None and current is not None:
        current.hunks.append(current_hunk)
    return patches


def apply_file_patch(patch: FilePatch) -> None:
    relative = str(patch.path.relative_to(ROOT))
    if patch.new_file:
        if patch.path.exists():
            raise RuntimeError(f"new file already exists: {relative}")
        parts: list[str] = []
        for hunk in patch.hunks:
            for line in hunk:
                if line.startswith("+"):
                    parts.append(line[1:])
                elif line.startswith(" "):
                    parts.append(line[1:])
                elif line.startswith("-"):
                    raise RuntimeError(f"new-file hunk removed content: {relative}")
        patch.path.parent.mkdir(parents=True, exist_ok=True)
        patch.path.write_text("".join(parts), encoding="utf-8")
        return

    if not patch.path.is_file():
        raise RuntimeError(f"patch target missing: {relative}")
    content = patch.path.read_text(encoding="utf-8")
    cursor = 0
    for index, hunk in enumerate(patch.hunks, start=1):
        old = "".join(line[1:] for line in hunk if line.startswith((" ", "-")))
        new = "".join(line[1:] for line in hunk if line.startswith((" ", "+")))
        if not old:
            raise RuntimeError(f"empty replacement hunk {index}: {relative}")
        position = content.find(old, cursor)
        if position < 0:
            raise RuntimeError(
                f"hunk {index} was not found after offset {cursor} in {relative}"
            )
        if old == new:
            cursor = position + len(old)
            continue
        content = content[:position] + new + content[position + len(old):]
        cursor = position + len(new)
    patch.path.write_text(content, encoding="utf-8")


def main() -> None:
    all_patches: list[FilePatch] = []
    for patch_path in PATCHES:
        parsed = parse_patch(patch_path.read_text(encoding="utf-8"))
        if not parsed:
            raise RuntimeError(f"recovery patch contained no file changes: {patch_path.name}")
        all_patches.extend(parsed)
    for patch in all_patches:
        apply_file_patch(patch)
        print(f"applied {patch.path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
