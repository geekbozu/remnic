import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectLocalSessionSummaries, compileRedactionRules, runLocalSessionSummaryCliCommand } from "./index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-session-summary-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("collectLocalSessionSummaries produces metadata-only drafts without local paths or raw session keys", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "session.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          sessionKey: "local-session-secret",
          role: "user",
          timestamp: "2026-01-02T03:04:05.000Z",
          content:
            "Please inspect /Users/alex/src/private and email alex@example.com about http://internal.example.test",
        }),
        JSON.stringify({
          sessionKey: "local-session-secret",
          role: "assistant",
          timestamp: "2026-01-02T03:04:06.000Z",
          content: "Use API_KEY=super-secret and connect to 192.168.1.10.",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "generic-jsonl",
      now: new Date("2026-01-02T04:00:00.000Z"),
    });

    assert.equal(report.filesScanned, 1);
    assert.equal(report.filesParsed, 1);
    assert.equal(report.turnsParsed, 2);
    assert.equal(report.sessionsSummarized, 1);
    const draft = report.drafts[0];
    assert.equal(draft.turnCount, 2);
    assert.equal(draft.roles.user, 1);
    assert.equal(draft.roles.assistant, 1);
    assert.equal(draft.metadata.storesRawTranscript, false);
    assert.equal(draft.metadata.storesLocalPaths, false);
    assert.equal(draft.metadata.storesSourceSessionKey, false);
    assert.equal(draft.sourceFileRefs.length, 1);
    assert.match(draft.sourceFileRefs[0].hash, /^[a-f0-9]{24}$/);

    const serialized = JSON.stringify(draft);
    assert.equal(serialized.includes(transcriptPath), false);
    assert.equal(serialized.includes("local-session-secret"), false);
    assert.equal(serialized.includes("/Users/alex"), false);
    assert.equal(serialized.includes("alex@example.com"), false);
    assert.equal(serialized.includes("192.168.1.10"), false);
    assert.equal(serialized.includes("super-secret"), false);
  });
});

test("includeRedactedExcerpts emits sanitized excerpts only", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        session_key: "thread-1",
        sender: "human",
        created_at: "2026-02-03T00:00:00.000Z",
        text: "Read /home/person/work and send results to person@example.com",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });
    const draft = report.drafts[0];
    assert.equal(draft.excerpts?.length, 1);
    assert.equal(draft.excerpts?.[0].text, "Read [REDACTED_PATH] and send results to [REDACTED_EMAIL]");
    assert.deepEqual(draft.redaction.ruleNames, ["absolute-posix-path", "email"]);
  });
});

test("includeRedactedExcerpts forces default redaction when defaults are disabled", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        session_key: "thread-1",
        sender: "human",
        created_at: "2026-02-03T00:00:00.000Z",
        text: "Read /home/person/work and send results to person@example.com",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
      redactionConfig: { disableDefaults: true },
    });
    const draft = report.drafts[0];
    assert.equal(draft.excerpts?.[0].text, "Read [REDACTED_PATH] and send results to [REDACTED_EMAIL]");
    assert.equal(draft.redaction.enabled, true);
    assert.equal(
      report.warnings.some((warning) => warning.code === "session-summaries.default_redaction_forced_for_excerpts"),
      true
    );
  });
});

test("parsing falls back to later non-empty content fields", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "fallback-session",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "",
        text: "Use this fallback text.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 1);
    assert.equal(report.drafts[0].excerpts?.[0].text, "Use this fallback text.");
  });
});

test("parsing reads top-level parts and input content fields", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      [
        JSON.stringify({
          sessionKey: "parts-session",
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          parts: [{ text: "Use parts text." }],
        }),
        JSON.stringify({
          sessionKey: "parts-session",
          role: "assistant",
          timestamp: "2026-02-03T00:00:01.000Z",
          input: "Use input text.",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 2);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["Use parts text.", "Use input text."]
    );
  });
});

test("codex-jsonl parses Codex rollout payload rows", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "event_msg",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:00.000Z",
          payload: { message: "User message from payload." },
        }),
        JSON.stringify({
          type: "response_item",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:01.000Z",
          payload: { content: [{ type: "output_text", text: "Assistant response from payload." }] },
        }),
        JSON.stringify({
          type: "event_msg",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:02.000Z",
          payload: { type: "agent_message", message: "Agent event message from payload." },
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "codex-jsonl",
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 3);
    assert.equal(report.drafts[0].roles.user, 1);
    assert.equal(report.drafts[0].roles.assistant, 2);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["User message from payload.", "Assistant response from payload.", "Agent event message from payload."]
    );
  });
});

test("payload.message metadata contributes session, role, and timestamp", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "nested.jsonl");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: "event_msg",
        payload: {
          message: {
            sessionId: "nested-payload-session",
            role: "assistant",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Nested assistant content.",
          },
        },
      }),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: "event_msg",
        payload: {
          message: {
            sessionId: "nested-payload-session",
            role: "assistant",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Changed nested assistant content.",
          },
        },
      }),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
    assert.equal(firstReport.drafts[0].roles.assistant, 1);
    assert.equal(firstReport.drafts[0].firstTimestamp, "2026-02-03T00:00:00.000Z");
  });
});

test("claude-jsonl ignores tool_result blocks instead of storing them as user excerpts", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "claude.jsonl"),
      [
        JSON.stringify({
          sessionId: "claude-session",
          message: {
            role: "user",
            content: [{ type: "tool_result", content: "local command output" }],
          },
        }),
        JSON.stringify({
          sessionId: "claude-session",
          message: {
            role: "user",
            content: [{ type: "text", text: "Actual user message." }],
          },
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "claude-jsonl",
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 1);
    assert.equal(report.drafts[0].roles.user, 1);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["Actual user message."]
    );
  });
});

test("sessionId fields produce stable session refs across content changes", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "session.jsonl");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        sessionId: "stable-session",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Original content.",
      }),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      JSON.stringify({
        sessionId: "stable-session",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Changed content.",
      }),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
  });
});

test("numeric sessionId fields produce stable session refs", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      [
        JSON.stringify({
          sessionId: 12345,
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "One",
        }),
        JSON.stringify({
          sessionId: 12345,
          role: "assistant",
          timestamp: "2026-02-03T00:00:01.000Z",
          content: "Two",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(report.sessionsSummarized, 1);
    assert.equal(report.drafts[0].turnCount, 2);
  });
});

test("JSONL rows inherit the previous stable session id in file order", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      [
        JSON.stringify({
          sessionId: "jsonl-session",
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "One",
        }),
        JSON.stringify({
          role: "assistant",
          timestamp: "2026-02-03T00:00:01.000Z",
          content: "Two",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(report.sessionsSummarized, 1);
    assert.equal(report.drafts[0].turnCount, 2);
  });
});

test("JSONL rows inherit stable session id from metadata-only rows", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "session.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "metadata-session", created_at: "2026-02-03T00:00:00.000Z" }),
        JSON.stringify({
          role: "user",
          timestamp: "2026-02-03T00:00:01.000Z",
          content: "Original content.",
        }),
      ].join("\n"),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "metadata-session", created_at: "2026-02-03T00:00:00.000Z" }),
        JSON.stringify({
          role: "user",
          timestamp: "2026-02-03T00:00:01.000Z",
          content: "Changed content.",
        }),
      ].join("\n"),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
  });
});

test("JSON envelope sessionId fields are inherited by child rows", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "session.json");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        sessionId: "stable-envelope-session",
        messages: [
          {
            role: "user",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Original content.",
          },
        ],
      }),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      JSON.stringify({
        sessionId: "stable-envelope-session",
        messages: [
          {
            role: "user",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Changed content.",
          },
        ],
      }),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
  });
});

test("inputDir supports tilde expansion", async () => {
  const dir = await mkdtemp(path.join(os.homedir(), ".remnic-session-summary-"));
  try {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "home-session",
        role: "assistant",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Home-relative input worked.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: `~/${path.basename(dir)}`,
    });

    assert.equal(report.filesParsed, 1);
    assert.equal(report.sessionsSummarized, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inputDir rejects symlinked roots", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "target");
    const link = path.join(dir, "link");
    await mkdir(target);
    await writeFile(
      path.join(target, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Should not be scanned through symlink.",
      }),
      "utf-8"
    );
    await symlink(target, link, "dir");

    await assert.rejects(() => collectLocalSessionSummaries({ inputDir: link }), /symbolic link/i);
  });
});

test("inputDir skips nested symlinks while scanning", async () => {
  await withTempDir(async (dir) => {
    const inputDir = path.join(dir, "input");
    const outsideDir = path.join(dir, "outside");
    await mkdir(inputDir);
    await mkdir(outsideDir);
    await writeFile(
      path.join(outsideDir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "outside",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Should not be read through a nested symlink.",
      }),
      "utf-8"
    );
    await symlink(outsideDir, path.join(inputDir, "linked-outside"), "dir");

    const report = await collectLocalSessionSummaries({ inputDir });

    assert.equal(report.filesScanned, 0);
    assert.equal(report.turnsParsed, 0);
  });
});

test("maxFiles reports truncation instead of dropping files silently", async () => {
  await withTempDir(async (dir) => {
    for (const name of ["a", "b"]) {
      await writeFile(
        path.join(dir, `${name}.jsonl`),
        JSON.stringify({
          sessionKey: name,
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: name,
        }),
        "utf-8"
      );
    }

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      maxFiles: 1,
    });

    assert.equal(report.filesScanned, 1);
    assert.equal(
      report.warnings.some((warning) => warning.code === "session-summaries.max_files_truncated"),
      true
    );
  });
});

test("maxFiles uses deterministic sorted file order", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "b.jsonl"),
      JSON.stringify({
        sessionKey: "b",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "B",
      }),
      "utf-8"
    );
    await writeFile(
      path.join(dir, "a.jsonl"),
      JSON.stringify({
        sessionKey: "a",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "A",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
      maxFiles: 1,
    });

    assert.equal(report.drafts[0].sourceSessionRef, "ca978112ca1bbdca");
    assert.equal(report.drafts[0].excerpts?.[0].text, "A");
  });
});

test("maxSessions reports truncation instead of dropping sessions silently", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "sessions.jsonl"),
      [
        JSON.stringify({
          sessionKey: "session-a",
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "A",
        }),
        JSON.stringify({
          sessionKey: "session-b",
          role: "user",
          timestamp: "2026-02-03T00:01:00.000Z",
          content: "B",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      maxSessions: 1,
    });

    assert.equal(report.sessionsSummarized, 1);
    assert.equal(
      report.warnings.some((warning) => warning.code === "session-summaries.max_sessions_truncated"),
      true
    );
  });
});

test("duplicate transcript files are skipped by content hash", async () => {
  await withTempDir(async (dir) => {
    const content = JSON.stringify({
      sessionKey: "duplicate-session",
      role: "user",
      timestamp: "2026-02-03T00:00:00.000Z",
      content: "Count this once.",
    });
    await writeFile(path.join(dir, "a.jsonl"), content, "utf-8");
    await writeFile(path.join(dir, "b.jsonl"), content, "utf-8");

    const report = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(report.filesScanned, 2);
    assert.equal(report.filesParsed, 1);
    assert.equal(report.turnsParsed, 1);
    assert.equal(report.drafts[0].turnCount, 1);
    assert.equal(
      report.warnings.some((warning) => warning.code === "session-summaries.duplicate_file_skipped"),
      true
    );
  });
});

test("runLocalSessionSummaryCliCommand writes opt-in Remnic draft JSONL", async () => {
  await withTempDir(async (dir) => {
    const inputDir = path.join(dir, "transcripts");
    const memoryDir = path.join(dir, "memory");
    await mkdir(inputDir, { recursive: true });
    await writeFile(
      path.join(inputDir, "session.json"),
      JSON.stringify({
        messages: [
          {
            conversation_id: "conversation-1",
            role: "user",
            timestamp: "2026-03-04T05:00:00.000Z",
            content: "Remember project status without raw transcript storage.",
          },
        ],
      }),
      "utf-8"
    );

    const report = await runLocalSessionSummaryCliCommand({
      inputDir,
      memoryDir,
      write: true,
      now: new Date("2026-03-04T06:00:00.000Z"),
    });

    assert.equal(report.wroteFiles.length, 1);
    assert.match(report.wroteFiles[0], /state\/session-summary-drafts\/session-summaries-/);
    const written = await readFile(report.wroteFiles[0], "utf-8");
    assert.equal(written.trim().split("\n").length, 1);
    assert.equal(written.includes("conversation-1"), false);
    assert.equal(written.includes(inputDir), false);
  });
});

test("custom redaction config adds user-defined rules", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: "Internal ticket ABC-123 should be hidden.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
      redactionConfig: {
        rules: [
          {
            name: "ticket",
            pattern: "\\bABC-\\d+\\b",
            replacement: "[REDACTED_TICKET]",
          },
        ],
      },
    });

    assert.equal(report.drafts[0].excerpts?.[0].text, "Internal ticket [REDACTED_TICKET] should be hidden.");
    assert.equal(report.drafts[0].redaction.ruleNames.includes("ticket"), true);
  });
});

test("custom redaction flags remain global", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: "Hide ABC and abc.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
      redactionConfig: {
        rules: [
          {
            name: "letters",
            pattern: "abc",
            flags: "i",
            replacement: "[REDACTED_LETTERS]",
          },
        ],
      },
    });

    assert.equal(report.drafts[0].excerpts?.[0].text, "Hide [REDACTED_LETTERS] and [REDACTED_LETTERS].");
    assert.equal(report.drafts[0].redaction.applied, 2);
  });
});

test("redaction covers quoted secret values with spaces", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: 'Use password="correct horse battery" for the test account.',
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.drafts[0].excerpts?.[0].text, "Use [REDACTED_SECRET] for the test account.");
  });
});

test("custom redaction rules must be an array", async () => {
  assert.throws(
    () => compileRedactionRules({ rules: { name: "bad", pattern: "bad" } } as never),
    /redaction rules must be an array/
  );
});

test("redaction covers common absolute POSIX paths", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content:
          "Inspect /workspace/remnic/secrets, /root/.ssh/config, /home/alex/.env.local, /Users/alex/My Documents/secret.txt, /Users/alex/secret file.txt, /Users/alex/Project (Client)/secret.txt, /secrets, and /tmp/customer-notes.pdf.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      "Inspect [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], and [REDACTED_PATH]."
    );
  });
});

test("redaction covers home-relative POSIX paths with spaced filenames", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: "Inspect ~/My Documents/secret file.txt before replying.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.drafts[0].excerpts?.[0].text, "Inspect [REDACTED_PATH] before replying.");
  });
});

test("redaction covers UNC Windows paths", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content:
          "Inspect C:\\Users\\alex\\secret file.txt, C:\\Users\\alex\\Secret Project before replying, \\\\server\\share\\client\\secret.txt, and \\\\server\\share\\client\\Secret Project before replying.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      "Inspect [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], and [REDACTED_PATH]"
    );
  });
});

test("redaction config file must be a JSON object", async () => {
  await withTempDir(async (dir) => {
    const inputDir = path.join(dir, "transcripts");
    const configPath = path.join(dir, "redaction.json");
    await mkdir(inputDir);
    await writeFile(
      path.join(inputDir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: "hello",
      }),
      "utf-8"
    );
    await writeFile(configPath, "[]", "utf-8");

    await assert.rejects(
      () =>
        runLocalSessionSummaryCliCommand({
          inputDir,
          redactionConfigPath: configPath,
        }),
      /redaction config must be a JSON object/
    );
  });
});

test("strict mode rejects malformed JSONL", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "bad.jsonl"), "{not json}\n", "utf-8");
    await assert.rejects(() => collectLocalSessionSummaries({ inputDir: dir, strict: true }), /invalid JSONL line/i);
  });
});
