"""Matching, moved from spikes/task-matching: anchors, entities, meaning, then the AI judge."""

from .matcher import (MATCHER_VERSION, Context, apply_verdicts, create_from_ask, cursors, ingest, keep_separate,
                      merge, pending_judgments, propose, split, unmerge_side_tables)

__all__ = ["MATCHER_VERSION", "Context", "apply_verdicts", "create_from_ask", "cursors", "ingest", "keep_separate",
           "merge", "pending_judgments", "propose", "split", "unmerge_side_tables"]
