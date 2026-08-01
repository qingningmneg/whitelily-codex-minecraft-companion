import type { ReactNode } from "react";

interface StatusCardProps {
  id: string;
  title: string;
  value: string;
  detail?: string;
  tone?: "calm" | "positive" | "warning";
  children?: ReactNode;
}

export function StatusCard({ id, title, value, detail, tone = "calm", children }: StatusCardProps) {
  const headingId = `${id}-heading`;

  return (
    <section className={`status-card status-card--${tone}`} aria-labelledby={headingId}>
      <div className="status-card__topline">
        <span className="status-card__indicator" aria-hidden="true" />
        <h3 id={headingId}>{title}</h3>
      </div>
      <p className="status-card__value">{value}</p>
      {detail ? <p className="status-card__detail">{detail}</p> : null}
      {children}
    </section>
  );
}
