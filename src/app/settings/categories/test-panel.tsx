"use client";

import { useEffect, useRef, useState } from "react";
import { type RuleActionResult, testRuleAction } from "./actions.ts";

/**
 * Live regex tester. Debounced to 300ms; rate-limited at the action layer.
 *
 * Per CLAUDE.md security pass: regex is fed only to `new RegExp` (no eval),
 * and the action caps results at 20 to bound regex-DOS risk on pathological
 * patterns.
 */
export function TestPanel(): React.JSX.Element {
  const [pattern, setPattern] = useState("");
  const [flags, setFlags] = useState("i");
  const [field, setField] = useState<"name" | "memo">("name");
  const [result, setResult] = useState<RuleActionResult | null>(null);
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!pattern.trim()) {
      setResult(null);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setPending(true);
    timerRef.current = setTimeout(async () => {
      const fd = new FormData();
      fd.set("pattern", pattern);
      fd.set("flags", flags);
      fd.set("field", field);
      const res = await testRuleAction({}, fd);
      setResult(res);
      setPending(false);
    }, 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [pattern, flags, field]);

  return (
    <section className="mt-8 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="font-medium">Test rule against existing transactions</h2>
      <div className="mt-3 grid grid-cols-12 gap-2">
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="Type a pattern…"
          className="col-span-7 rounded-md border border-zinc-300 px-2 py-1 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <input
          value={flags}
          onChange={(e) => setFlags(e.target.value)}
          className="col-span-2 rounded-md border border-zinc-300 px-2 py-1 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <select
          value={field}
          onChange={(e) => setField(e.target.value === "memo" ? "memo" : "name")}
          className="col-span-3 rounded-md border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="name">name</option>
          <option value="memo">memo</option>
        </select>
      </div>

      <div className="mt-3 text-xs">
        {pending && <span className="text-zinc-500">Searching…</span>}
        {!pending && result?.error && (
          <span className="text-red-700 dark:text-red-300">{result.error}</span>
        )}
        {!pending && result?.testMatches && result.testMatches.length === 0 && (
          <span className="text-zinc-500">No matches.</span>
        )}
      </div>

      {result?.testMatches && result.testMatches.length > 0 && (
        <ul className="mt-2 max-h-60 space-y-0.5 overflow-y-auto text-sm">
          {result.testMatches.map((m) => (
            <li key={m.id} className="font-mono text-xs">
              <span className="text-zinc-500">{m.postedAt}</span> · {m.name}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
