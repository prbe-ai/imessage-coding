"use client";

/**
 * Onboarding chrome — a single centered column on the cream marketing canvas,
 * mirroring prbe-dashboard's `OnboardingShell`. Small Probe mark top-left, an
 * optional `rightTop` slot (the account menu) top-right, and the step content
 * (header + body + nav buttons) vertically + horizontally centered.
 *
 * Styling lives in src/app/globals.css (the `.onb-centered-*` block).
 */

import { type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { ProbeMark } from "@/components/icons";

export type OnboardingShellProps = {
  /** Stable key per logical step. When it changes, the content re-mounts and
   *  the fade-rise animation re-fires. */
  stepKey: string;
  /** Header content — typically `<StepVisual icon={...} title="…" />`. */
  leftVisual?: ReactNode;
  /** Override for the top-left mark. Defaults to the Probe glyph; pass `null`
   *  to suppress entirely. */
  leftTop?: ReactNode;
  /** Top-right slot — typically the signed-in user's account menu. */
  rightTop?: ReactNode;
  /** Step body — form, cards, status. */
  children: ReactNode;
  /** Step footer — primary / secondary nav buttons, inside the column. */
  footer?: ReactNode;
  /** Widen the column from ~440px to ~640px for denser content. */
  rightWide?: boolean;
};

export function OnboardingShell({
  stepKey,
  leftVisual,
  leftTop,
  rightTop,
  children,
  footer,
  rightWide,
}: OnboardingShellProps) {
  const topLeft =
    leftTop === undefined ? (
      <span className="onb-centered-toplogo" aria-hidden="true">
        <ProbeMark />
      </span>
    ) : (
      leftTop
    );
  return (
    <div className="onb-root onb-centered-page">
      <header className="onb-centered-topbar">
        <div className="onb-centered-topbar-left">{topLeft}</div>
        <div className="onb-centered-topbar-right">{rightTop ?? null}</div>
      </header>
      <main className="onb-centered-main">
        <div
          key={stepKey}
          className={`onb-centered-stack onb-step-fade${rightWide ? " onb-centered-stack-wide" : ""}`}
        >
          {leftVisual && <div className="onb-centered-header">{leftVisual}</div>}
          <div className="onb-centered-body">{children}</div>
          {footer && <div className="onb-centered-actions">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

/** Standard step header: minimalist icon above a single-line title. */
export function StepVisual({
  icon,
  title,
}: {
  icon?: ReactNode;
  title: ReactNode;
}) {
  return (
    <h2 className="onb-step-title">
      {icon && (
        <span className="onb-step-mark" aria-hidden="true">
          {icon}
        </span>
      )}
      {title}
    </h2>
  );
}

/** Loading view: spinner + message in place of the step body. */
export function LoadingPane({
  stepKey,
  rightTop,
  leftVisual,
  leftTop,
  message,
  children,
}: {
  stepKey: string;
  rightTop?: ReactNode;
  leftVisual?: ReactNode;
  leftTop?: ReactNode;
  message: ReactNode;
  children?: ReactNode;
}) {
  return (
    <OnboardingShell
      stepKey={stepKey}
      rightTop={rightTop}
      leftTop={leftTop}
      leftVisual={leftVisual}
    >
      <div className="onb-loading-block">
        <Loader2 className="onb-spin" aria-hidden="true" />
        <p className="onb-loading-msg">{message}</p>
        {children}
      </div>
    </OnboardingShell>
  );
}
