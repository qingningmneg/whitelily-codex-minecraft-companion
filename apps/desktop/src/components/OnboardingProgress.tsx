import type { Locale, MessageKey } from "../i18n/messageKeys";
import { translate } from "../i18n/translator";

export type OnboardingStep = "environment" | "login" | "model" | "owner" | "pcl2" | "lan" | "ready";

interface OnboardingProgressProps {
  locale: Locale;
  step: OnboardingStep;
}

const steps: readonly OnboardingStep[] = [
  "environment",
  "login",
  "model",
  "owner",
  "pcl2",
  "lan",
  "ready",
];

export function OnboardingProgress({ locale, step }: OnboardingProgressProps) {
  const current = steps.indexOf(step);

  return (
    <nav className="onboarding-progress" aria-label={translate(locale, "onboarding.progress")}>
      <ol>
        {steps.map((item, index) => (
          <li
            className={
              index < current
                ? "onboarding-progress__item onboarding-progress__item--complete"
                : index === current
                  ? "onboarding-progress__item onboarding-progress__item--current"
                  : "onboarding-progress__item"
            }
            key={item}
            aria-current={index === current ? "step" : undefined}
          >
            <span className="onboarding-progress__marker" aria-hidden="true">
              {index < current ? "✓" : index + 1}
            </span>
            <span>{translate(locale, `onboarding.step.${item}` as MessageKey)}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
