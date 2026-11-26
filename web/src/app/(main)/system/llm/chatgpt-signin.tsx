"use client";

import * as React from "react";

import { CheckCircle2Icon, Loader2Icon, LogInIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

// Sign in with ChatGPT for an openai-codex profile.
//
// Opens OpenAI's login in a new tab; OpenAI redirects back to localhost:1455, which
// the backend listens on, and this component polls until the sign-in finishes. The
// tokens stay on the server — the parent only receives the login `state`, which it
// passes as `oauth_state` when saving/testing the profile. If the browser can't reach
// localhost:1455 (AntiFox on a remote host), the user pastes the redirect URL instead.

const POLL_MS = 1500;
const POLL_LIMIT_MS = 10 * 60 * 1000;

const labelOf = (email?: string, plan?: string) =>
  [plan ? `ChatGPT ${plan}` : "ChatGPT", email].filter(Boolean).join(" · ");

export function ChatGPTSignIn({
  savedHint,
  onSignedIn,
}: {
  /** api_key_hint of the saved profile (plan · email), if already signed in. */
  savedHint?: string;
  /** Called with the finished login state (or "" when reset). */
  onSignedIn: (state: string) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = React.useState("");
  const [phase, setPhase] = React.useState<"idle" | "waiting" | "done">("idle");
  const [label, setLabel] = React.useState("");
  const [listenWarn, setListenWarn] = React.useState("");
  const [pasted, setPasted] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = React.useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);
  React.useEffect(() => stopPolling, [stopPolling]);

  const finish = React.useCallback(
    (st: string, email?: string, plan?: string) => {
      stopPolling();
      const l = labelOf(email, plan);
      setLabel(l);
      setPhase("done");
      onSignedIn(st);
      toast.success(t("llm.chatgpt.ok", { label: l }));
    },
    [onSignedIn, stopPolling, t],
  );

  const fail = React.useCallback(
    (msg: string) => {
      stopPolling();
      setPhase("idle");
      toast.error(t("llm.chatgpt.failed", { msg }));
    },
    [stopPolling, t],
  );

  async function start() {
    // Open the tab synchronously inside the click handler so pop-up blockers allow it.
    const tab = window.open("", "_blank");
    if (!tab) {
      toast.error(t("llm.chatgpt.popupBlocked"));
      return;
    }
    try {
      const r = await api.codexAuthStart();
      tab.location.href = r.auth_url;
      setState(r.state);
      setListenWarn(r.listen_error ?? "");
      setPasted("");
      setPhase("waiting");
      onSignedIn("");
      const began = Date.now();
      stopPolling();
      timer.current = setInterval(async () => {
        if (Date.now() - began > POLL_LIMIT_MS) {
          fail("timed out");
          return;
        }
        try {
          const s = await api.codexAuthStatus(r.state);
          if (s.status === "done") finish(r.state, s.email, s.plan);
          else if (s.status === "error") fail(s.error ?? "unknown error");
        } catch {
          /* transient — keep polling */
        }
      }, POLL_MS);
    } catch (e) {
      tab.close();
      fail((e as Error).message);
    }
  }

  async function submitPasted() {
    if (!pasted.trim() || !state) return;
    setSubmitting(true);
    try {
      const s = await api.codexAuthComplete(state, pasted.trim());
      if (s.status === "done") finish(state, s.email, s.plan);
      else toast.error(t("llm.chatgpt.failed", { msg: s.error ?? s.status }));
    } catch (e) {
      toast.error(t("llm.chatgpt.failed", { msg: (e as Error).message }));
    } finally {
      setSubmitting(false);
    }
  }

  function cancel() {
    stopPolling();
    setPhase("idle");
    setState("");
    onSignedIn("");
  }

  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="grid gap-0.5">
        <Label className="text-sm">{t("llm.chatgpt.title")}</Label>
        <p className="text-muted-foreground text-xs">{t("llm.chatgpt.desc")}</p>
      </div>

      {phase === "done" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <CheckCircle2Icon className="size-4 text-emerald-600" />
          <span>{t("llm.chatgpt.signedInNew", { label })}</span>
        </div>
      ) : savedHint && phase === "idle" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <CheckCircle2Icon className="size-4 text-emerald-600" />
          <span>{t("llm.chatgpt.signedIn", { label: savedHint })}</span>
        </div>
      ) : phase === "idle" ? (
        <p className="text-muted-foreground text-sm">{t("llm.chatgpt.notSignedIn")}</p>
      ) : null}

      {phase === "waiting" ? (
        <div className="grid gap-2">
          <div className="flex items-center gap-2 text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{t("llm.chatgpt.waiting")}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={cancel}>
              {t("llm.chatgpt.cancel")}
            </Button>
          </div>
          {listenWarn && <p className="text-amber-600 text-xs">{t("llm.chatgpt.listenWarn", { msg: listenWarn })}</p>}
          <p className="text-muted-foreground text-xs">{t("llm.chatgpt.pasteHint")}</p>
          <div className="flex gap-2">
            <Input
              className="font-mono text-xs"
              placeholder={t("llm.chatgpt.pastePlaceholder")}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <Button size="sm" variant="outline" disabled={!pasted.trim() || submitting} onClick={submitPasted}>
              {submitting ? <Loader2Icon className="animate-spin" /> : null}
              {t("llm.chatgpt.pasteSubmit")}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button size="sm" variant={savedHint || phase === "done" ? "outline" : "default"} onClick={start}>
            <LogInIcon />
            {savedHint || phase === "done" ? t("llm.chatgpt.signInAgain") : t("llm.chatgpt.signIn")}
          </Button>
        </div>
      )}
    </div>
  );
}
