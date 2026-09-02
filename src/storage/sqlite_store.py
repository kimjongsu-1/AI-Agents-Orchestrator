#!/usr/bin/env python3
"""Local SQLite mirror for AI Orchestrator state.

Electron/Node 쪽은 기존 JSON 상태 파일을 즉시 저장소로 사용하고,
이 스크립트는 같은 내용을 SQLite로 동기화한다.
이 구조는 LangGraph Checkpointer를 붙일 때 thread/project 단위 재개 지점으로 확장하기 쉽다.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT,
            workspace_path TEXT,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            role TEXT,
            author TEXT,
            text TEXT,
            created_at TEXT,
            FOREIGN KEY(project_id) REFERENCES projects(id)
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            run_id TEXT,
            state TEXT,
            name TEXT,
            detail TEXT,
            created_at TEXT,
            FOREIGN KEY(project_id) REFERENCES projects(id)
        );

        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            agent_id TEXT,
            instruction TEXT,
            prompt_file TEXT,
            log_file TEXT,
            workspace_path TEXT,
            state TEXT,
            exit_code INTEGER,
            raw_output_bytes INTEGER,
            output TEXT,
            created_at TEXT,
            started_at TEXT,
            finished_at TEXT,
            updated_at TEXT,
            FOREIGN KEY(project_id) REFERENCES projects(id)
        );

        CREATE TABLE IF NOT EXISTS usage_events (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            run_id TEXT,
            agent_id TEXT,
            usage_type TEXT,
            provider TEXT,
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            call_count INTEGER DEFAULT 1,
            estimated_cost_krw REAL DEFAULT 0,
            actual_cost_krw REAL DEFAULT 0,
            cloud_equivalent_cost_krw REAL DEFAULT 0,
            saved_cost_krw REAL DEFAULT 0,
            is_local INTEGER DEFAULT 0,
            note TEXT,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            node_name TEXT,
            state_json TEXT NOT NULL,
            metadata_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            type TEXT,
            text TEXT,
            tags_json TEXT,
            created_at TEXT
        );

        CREATE TABLE IF NOT EXISTS automations (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            name TEXT,
            schedule TEXT,
            enabled INTEGER DEFAULT 1,
            last_run_at TEXT,
            created_at TEXT
        );
        """
    )


def sync(json_path: Path, db_path: Path) -> None:
    data = json.loads(json_path.read_text(encoding="utf-8"))
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    try:
        init_db(conn)
        with conn:
            conn.execute("DELETE FROM checkpoints")
            conn.execute("DELETE FROM memories")
            conn.execute("DELETE FROM automations")
            for project in data.get("projects", []):
                conn.execute(
                    """
                    INSERT INTO projects(id, title, status, workspace_path, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                      title=excluded.title,
                      status=excluded.status,
                      workspace_path=excluded.workspace_path,
                      updated_at=excluded.updated_at
                    """,
                    (
                        project.get("id"),
                        project.get("title") or "Untitled",
                        project.get("status"),
                        project.get("workspacePath"),
                        project.get("createdAt"),
                        project.get("updatedAt"),
                    ),
                )

                for message in project.get("messages", []):
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO messages(id, project_id, role, author, text, created_at)
                        VALUES(?, ?, ?, ?, ?, ?)
                        """,
                        (
                            message.get("id"),
                            project.get("id"),
                            message.get("role"),
                            message.get("author"),
                            message.get("text"),
                            message.get("createdAt"),
                        ),
                    )

                for task in project.get("tasks", []):
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO tasks(id, project_id, run_id, state, name, detail, created_at)
                        VALUES(?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            task.get("id"),
                            project.get("id"),
                            task.get("runId"),
                            task.get("state"),
                            task.get("name"),
                            task.get("detail"),
                            task.get("createdAt"),
                        ),
                    )

            for run in data.get("runs", []):
                conn.execute(
                    """
                    INSERT OR REPLACE INTO runs(
                      id, project_id, agent_id, instruction, prompt_file, log_file,
                      workspace_path, state, exit_code, raw_output_bytes, output,
                      created_at, started_at, finished_at, updated_at
                    )
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run.get("id"),
                        run.get("projectId"),
                        run.get("agentId"),
                        run.get("instruction"),
                        run.get("promptFile"),
                        run.get("logFile"),
                        run.get("workspacePath"),
                        run.get("state"),
                        run.get("exitCode"),
                        run.get("rawOutputBytes"),
                        run.get("output"),
                        run.get("createdAt"),
                        run.get("startedAt"),
                        run.get("finishedAt"),
                        run.get("updatedAt"),
                    ),
                )

            for event in data.get("usageEvents", []):
                conn.execute(
                    """
                    INSERT OR REPLACE INTO usage_events(
                      id, project_id, run_id, agent_id, usage_type, provider, model,
                      input_tokens, output_tokens, call_count, estimated_cost_krw,
                      actual_cost_krw, cloud_equivalent_cost_krw, saved_cost_krw,
                      is_local, note, created_at
                    )
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event.get("id"),
                        event.get("projectId"),
                        event.get("runId"),
                        event.get("agentId"),
                        event.get("usageType"),
                        event.get("provider"),
                        event.get("model"),
                        event.get("inputTokens") or 0,
                        event.get("outputTokens") or 0,
                        event.get("callCount") or 1,
                        event.get("estimatedCostKrw") or 0,
                        event.get("actualCostKrw") or 0,
                        event.get("cloudEquivalentCostKrw") or 0,
                        event.get("savedCostKrw") or 0,
                        1 if event.get("isLocal") else 0,
                        event.get("note"),
                        event.get("createdAt"),
                    ),
                )

            for checkpoint in data.get("checkpoints", []):
                conn.execute(
                    """
                    INSERT INTO checkpoints(project_id, thread_id, node_name, state_json, metadata_json, created_at)
                    VALUES(?, ?, ?, ?, ?, ?)
                    """,
                    (
                        checkpoint.get("projectId"),
                        checkpoint.get("threadId") or checkpoint.get("projectId"),
                        checkpoint.get("nodeName"),
                        json.dumps(checkpoint.get("state") or {}, ensure_ascii=False),
                        json.dumps(checkpoint.get("metadata") or {}, ensure_ascii=False),
                        checkpoint.get("createdAt"),
                    ),
                )

            for memory in data.get("memories", []):
                conn.execute(
                    """
                    INSERT OR REPLACE INTO memories(id, project_id, type, text, tags_json, created_at)
                    VALUES(?, ?, ?, ?, ?, ?)
                    """,
                    (
                        memory.get("id"),
                        memory.get("projectId"),
                        memory.get("type"),
                        memory.get("text"),
                        json.dumps(memory.get("tags") or [], ensure_ascii=False),
                        memory.get("createdAt"),
                    ),
                )

            for automation in data.get("automations", []):
                conn.execute(
                    """
                    INSERT OR REPLACE INTO automations(id, project_id, name, schedule, enabled, last_run_at, created_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        automation.get("id"),
                        automation.get("projectId"),
                        automation.get("name"),
                        automation.get("schedule"),
                        1 if automation.get("enabled", True) else 0,
                        automation.get("lastRunAt"),
                        automation.get("createdAt"),
                    ),
                )
    finally:
        conn.close()


def main(argv: list[str]) -> int:
    if len(argv) != 4 or argv[1] != "sync":
        print("usage: sqlite_store.py sync <state.json> <orchestrator.sqlite3>", file=sys.stderr)
        return 2
    sync(Path(argv[2]), Path(argv[3]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
