#!/usr/bin/env python3
"""Validate OPD visual-quality evidence without pretending to judge aesthetics."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


VISUAL_HEADING = "## 视觉质量证据"
ROW_ID = re.compile(r"^VQ-[A-Z0-9-]+$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate OPD visual evidence.")
    parser.add_argument("target", type=Path, help="OPD project directory")
    parser.add_argument(
        "--stage",
        choices=("structure", "p2"),
        default="structure",
        help="Validation depth",
    )
    return parser.parse_args()


def section_text(text: str, heading: str) -> str:
    start = text.find(heading)
    if start < 0:
        return ""
    section = text[start + len(heading) :]
    next_heading = re.search(r"\n## ", section)
    return section[: next_heading.start()] if next_heading else section


def rows(section: str) -> list[list[str]]:
    parsed: list[list[str]] = []
    for line in section.splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and cells[0] != "VQ-TBD" and ROW_ID.fullmatch(cells[0]):
            parsed.append(cells)
    return parsed


def validate(target: Path, stage: str) -> list[str]:
    errors: list[str] = []
    status_path = target.resolve() / "docs/PROJECT-STATUS.md"
    try:
        status = status_path.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"cannot read {status_path}: {exc}"]

    section = section_text(status, VISUAL_HEADING)
    if not section:
        return [f"PROJECT-STATUS missing heading: {VISUAL_HEADING}"]
    if stage == "structure":
        return errors

    evidence_rows = rows(section)
    if not evidence_rows:
        return ["visual evidence has no VQ row"]

    for cells in evidence_rows:
        if len(cells) != 16:
            errors.append(f"{cells[0]} must contain 16 columns")
            continue
        (
            vq_id,
            _surface,
            audience,
            _mode,
            risk,
            core,
            route,
            brand,
            hierarchy,
            composition,
            craft,
            responsive,
            states,
            desktop,
            mobile,
            conclusion,
        ) = cells
        if audience not in {"客户", "内部"}:
            errors.append(f"{vq_id} audience must be 客户 or 内部")
        if risk not in {"L0", "L1", "L2", "L3"}:
            errors.append(f"{vq_id} risk must be L0-L3")
        if core != "已执行":
            errors.append(f"{vq_id} built-in visual core is not executed")
        if not route or route in {"待定", "TBD"}:
            errors.append(f"{vq_id} lacks expert route or skip reason")
        score_fields = (
            ("brand", brand, 20),
            ("hierarchy", hierarchy, 20),
            ("composition", composition, 20),
            ("craft", craft, 15),
            ("responsive", responsive, 15),
            ("states", states, 10),
        )
        scores: list[int] = []
        for label, value, maximum in score_fields:
            try:
                score = int(value)
            except ValueError:
                errors.append(f"{vq_id} {label} score is not an integer")
                continue
            if not 0 <= score <= maximum:
                errors.append(f"{vq_id} {label} score outside 0-{maximum}")
            scores.append(score)
        if len(scores) == 6:
            total = sum(scores)
            threshold = 85 if audience == "客户" else 80
            if total < threshold:
                errors.append(f"{vq_id} score {total} is below {threshold}")
            if any(score < 12 for score in scores[:3]):
                errors.append(f"{vq_id} has a critical score below 60%")
        for label, evidence in (("desktop", desktop), ("mobile", mobile)):
            if not evidence or evidence in {"待补", "TBD", "N/A"}:
                errors.append(f"{vq_id} lacks {label} screenshot evidence")
        if conclusion not in {"通过", "用户确认"}:
            errors.append(f"{vq_id} conclusion is not passed")

    return sorted(set(errors))


def main() -> None:
    args = parse_args()
    errors = validate(args.target, args.stage)
    if errors:
        print(f"Visual validation failed ({args.stage}):", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        raise SystemExit(1)
    print(f"Visual evidence is valid for stage: {args.stage}")
    print(f"project: {args.target.resolve()}")


if __name__ == "__main__":
    main()
