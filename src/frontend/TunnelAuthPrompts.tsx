import { useEffect, useRef, useState } from "react";
import type { PluginSshPromptRequest } from "@termix-ssh/plugin-sdk/backend";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  answerLocalAuth,
  localC2SAvailable,
  onLocalAuthPrompt,
} from "./c2s-local-api";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
} from "@termix-ssh/plugin-sdk/ui";

type Challenge = {
  id: string;
  tunnelName?: string;
  request: PluginSshPromptRequest;
};

export function TunnelAuthPrompts() {
  const [queue, setQueue] = useState<Challenge[]>([]);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    const active = pending.current;
    if (!localC2SAvailable()) return;
    const dispose = onLocalAuthPrompt((event) => {
      if (event.type === "auth-prompt-closed") {
        active.delete(event.id);
        setQueue((items) => items.filter((item) => item.id !== event.id));
      } else if (!active.has(event.id)) {
        active.add(event.id);
        setQueue((items) => [
          ...items,
          {
            id: event.id,
            tunnelName: event.tunnelName,
            request: event.request,
          },
        ]);
      }
    });
    return () => {
      dispose();
      for (const id of active) void answerLocalAuth(id, null).catch(() => {});
      active.clear();
    };
  }, []);
  const current = queue[0];
  return current ? (
    <AuthDialog
      key={current.id}
      challenge={current}
      onAnswer={(answer) => {
        pending.current.delete(current.id);
        setQueue((items) => items.filter((item) => item.id !== current.id));
        void answerLocalAuth(current.id, answer).catch(() => {});
      }}
    />
  ) : null;
}

function AuthDialog({
  challenge,
  onAnswer,
}: {
  challenge: Challenge;
  onAnswer: (answer: string | null) => void;
}) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState("");
  const request = challenge.request;
  const browser = request.kind === "browser";
  const url =
    browser && request.url && /^https?:\/\//i.test(request.url)
      ? request.url
      : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onAnswer(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("tunnels.authTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm break-all">{challenge.tunnelName}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onAnswer(answer);
          }}
          className="space-y-3"
        >
          <p className="text-sm whitespace-pre-wrap">
            {browser ? request.instructions : request.prompt}
          </p>
          {request.kind === "totp" && request.retry && (
            <p role="alert">{t("tunnels.authRetry")}</p>
          )}
          {browser ? (
            <>
              <p>{request.code}</p>
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all underline"
                >
                  {url}
                </a>
              )}
            </>
          ) : (
            <Input
              autoFocus
              aria-label={t("tunnels.authAnswer")}
              autoComplete="off"
              type={
                request.kind === "input" && request.echo ? "text" : "password"
              }
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onAnswer(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="outline"
              type="submit"
              className="border-accent-brand/40 text-accent-brand hover:bg-accent-brand/10 hover:text-accent-brand dark:border-accent-brand/40 dark:bg-transparent dark:hover:bg-accent-brand/10"
            >
              {t("tunnels.authContinue")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
