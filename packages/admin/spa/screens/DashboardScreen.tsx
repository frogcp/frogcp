import type { EntitySchemaSummary } from "frogcp";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { roleForValue } from "@/components/ui/StatusPill";
import { Skeleton } from "@/components/ui/skeleton";
import { client } from "../api";
import { firstAutoTimestampField, firstSelectField, pickLabelField } from "../lib/schema";

export interface DashboardScreenProps {
  /** The full schema map already fetched once by `ShellScreen`. This screen
   * never fetches the schema itself, only per-entity data derived from it. */
  entities: Record<string, EntitySchemaSummary>;
}

type Row = Record<string, unknown>;

/** How many recent rows to pull per entity, before merging and trimming to
 * `RECENT_TOTAL` across all entities combined. */
const RECENT_PER_ENTITY = 5;
/** How many rows the merged "recent records" list shows overall, across every
 * entity that has an auto timestamp field. */
const RECENT_TOTAL = 8;
/** The window the optional "created over time" mini-chart buckets into. */
const TREND_DAYS = 14;
/** Rows sampled to build the trend: generous enough to cover `TREND_DAYS` for
 * a reasonably active entity without pulling the whole table. Rows older than
 * the window are simply not counted. */
const TREND_SAMPLE_LIMIT = 200;

interface StatusOption {
  option: string;
  /** `null` means the filtered count query failed (e.g. a 403). Rendered as
   * "n/a" so one denied count never crashes the section. */
  count: number | null;
}

interface StatusBreakdown {
  entityName: string;
  field: string;
  options: StatusOption[];
}

interface RecentRecord {
  entityName: string;
  id: string;
  label: string;
  timestamp: string;
}

interface TrendPoint {
  date: string;
  count: number;
}

interface TrendData {
  entityName: string;
  field: string;
  points: TrendPoint[];
}

function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Buckets already-fetched rows by calendar day over the trailing `TREND_DAYS`
 * window ending today. Local time, matching every other date rendering in this
 * admin. A row whose timestamp doesn't parse, or falls outside the window, is
 * simply not counted rather than synthesized.
 */
function bucketByDay(entityName: string, field: string, rows: readonly Row[]): TrendData {
  const today = new Date();
  const days: string[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(dayKey(d));
  }
  const counts = new Map<string, number>(days.map((d) => [d, 0]));
  for (const row of rows) {
    const raw = row[field];
    if (raw === null || raw === undefined) continue;
    const d = new Date(raw as string | number);
    if (Number.isNaN(d.getTime())) continue;
    const key = dayKey(d);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { entityName, field, points: days.map((date) => ({ date, count: counts.get(date) ?? 0 })) };
}

/**
 * The admin's schema-driven home screen. Every section is derived from the
 * schema summary alone (nothing is hardcoded to a particular app's entity or
 * field names) and every number comes from data that already exists: record
 * counts, a status breakdown per `select` field, recent rows per auto
 * timestamp field, and an optional created-over-time bar chart.
 *
 * A views-over-time chart and "vs previous period" deltas are deliberately
 * absent: there is no view history or historical snapshot to compute them
 * from, and inventing one would be dishonest.
 */
export function DashboardScreen({ entities }: DashboardScreenProps) {
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [breakdowns, setBreakdowns] = useState<StatusBreakdown[]>([]);
  const [recent, setRecent] = useState<RecentRecord[]>([]);
  const [trend, setTrend] = useState<TrendData | null>(null);

  const entityNames = useMemo(() => Object.keys(entities), [entities]);

  useEffect(() => {
    let cancelled = false;

    if (entityNames.length === 0) {
      setLoading(false);
      setCounts({});
      setBreakdowns([]);
      setRecent([]);
      setTrend(null);
      return;
    }

    setLoading(true);

    async function run() {
      // `list({ limit: 1 })`'s `meta.total` is a full, permission-filtered
      // count, not just "how many rows came back". `allSettled` keeps one
      // forbidden entity from blocking the rest.
      const countSettled = await Promise.allSettled(entityNames.map((name) => client.entity(name).list({ limit: 1 })));
      if (cancelled) return;
      const nextCounts: Record<string, number | null> = {};
      countSettled.forEach((result, i) => {
        const name = entityNames[i];
        if (name === undefined) return;
        nextCounts[name] = result.status === "fulfilled" ? result.value.meta.total : null;
      });
      setCounts(nextCounts);

      const selectTargets = entityNames
        .map((name) => {
          const field = firstSelectField(entities[name]?.fields ?? {});
          return field ? { name, fieldName: field[0], options: field[1].options ?? [] } : null;
        })
        .filter((t): t is { name: string; fieldName: string; options: readonly string[] } => t !== null);

      const breakdownSettled = await Promise.allSettled(
        selectTargets.map(async ({ name, fieldName, options }): Promise<StatusBreakdown> => {
          const optionSettled = await Promise.allSettled(
            options.map((option) => client.entity(name).list({ filter: { [fieldName]: option }, limit: 1 })),
          );
          return {
            entityName: name,
            field: fieldName,
            options: options.map((option, i) => {
              const r = optionSettled[i];
              return { option, count: r?.status === "fulfilled" ? r.value.meta.total : null };
            }),
          };
        }),
      );
      if (cancelled) return;
      setBreakdowns(
        breakdownSettled
          .filter((r): r is PromiseFulfilledResult<StatusBreakdown> => r.status === "fulfilled")
          .map((r) => r.value),
      );

      // The first auto-timestamp entity in schema order doubles as the trend
      // entity below, so it is fetched once at the larger `TREND_SAMPLE_LIMIT`
      // and its recent rows are sliced from that same result: one fewer
      // round-trip for identical top rows.
      const autoTargets = entityNames
        .map((name) => {
          const field = firstAutoTimestampField(entities[name]?.fields ?? {});
          return field ? { name, fieldName: field[0] } : null;
        })
        .filter((t): t is { name: string; fieldName: string } => t !== null);

      const trendTarget = autoTargets[0];

      function toRecentRecords(name: string, fieldName: string, rows: readonly Row[]): RecentRecord[] {
        const labelField = pickLabelField(entities[name]?.fields ?? {});
        return rows.slice(0, RECENT_PER_ENTITY).map((row) => {
          const rawLabel = labelField ? row[labelField] : undefined;
          const label = rawLabel !== null && rawLabel !== undefined && rawLabel !== "" ? String(rawLabel) : String(row.id);
          return { entityName: name, id: String(row.id), label, timestamp: String(row[fieldName]) };
        });
      }

      const recentSettled = await Promise.allSettled(
        autoTargets.map(async ({ name, fieldName }): Promise<{ recent: RecentRecord[]; trendRows?: readonly Row[] }> => {
          const isTrend = name === trendTarget?.name && fieldName === trendTarget.fieldName;
          const limit = isTrend ? TREND_SAMPLE_LIMIT : RECENT_PER_ENTITY;
          const result = await client.entity(name).list({ sort: [`-${fieldName}`], limit });
          const rows = result.data as Row[];
          return { recent: toRecentRecords(name, fieldName, rows), ...(isTrend ? { trendRows: rows } : {}) };
        }),
      );
      if (cancelled) return;
      const fulfilledRecent = recentSettled.filter(
        (r): r is PromiseFulfilledResult<{ recent: RecentRecord[]; trendRows?: readonly Row[] }> => r.status === "fulfilled",
      );
      const mergedRecent = fulfilledRecent
        .flatMap((r) => r.value.recent)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, RECENT_TOTAL);
      setRecent(mergedRecent);

      // If the trend entity's fetch rejected there are no `trendRows`, and the
      // chart section is omitted rather than drawn from nothing.
      const trendRows = fulfilledRecent.map((r) => r.value.trendRows).find((rows) => rows !== undefined);
      if (trendTarget && trendRows) {
        setTrend(bucketByDay(trendTarget.name, trendTarget.fieldName, trendRows));
      } else {
        setTrend(null);
      }

      if (!cancelled) setLoading(false);
    }

    run();
    return () => {
      cancelled = true;
    };
    // `entities` (the whole schema map) is the intended dependency; `entityNames` is derived from it each render.
  }, [entities]);

  if (entityNames.length === 0) {
    return (
      <div className="flex max-w-5xl flex-col gap-5">
        <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
          No entities in this schema yet.
        </div>
      </div>
    );
  }

  const knownCounts = Object.values(counts).filter((v): v is number => typeof v === "number");
  const totalRecords = knownCounts.reduce((sum, v) => sum + v, 0);
  const maxCount = Math.max(1, ...knownCounts);
  const maxTrendCount = trend ? Math.max(1, ...trend.points.map((p) => p.count)) : 1;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Live counts from today&apos;s data only. There is no event log yet, so this is not an activity feed
          (that&apos;s the future frogcp/activity plugin&apos;s job).
        </p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-4" role="status">
          <span className="sr-only">Loading…</span>
          <div className="grid grid-cols-2 gap-4 sm:max-w-md">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
          <Skeleton className="h-48" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:max-w-md">
            <Card>
              <CardContent className="flex flex-col gap-1">
                <span className="font-mono text-3xl tabular-nums text-primary">{totalRecords.toLocaleString()}</span>
                <span className="text-xs tracking-wide text-muted-foreground uppercase">Total records</span>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex flex-col gap-1">
                <span className="font-mono text-3xl tabular-nums text-primary">{entityNames.length.toLocaleString()}</span>
                <span className="text-xs tracking-wide text-muted-foreground uppercase">Entities</span>
              </CardContent>
            </Card>
          </div>

          <section>
            <Card>
              <CardHeader>
                <CardTitle>Records per entity</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-3">
                  {entityNames.map((name) => {
                    const total = counts[name] ?? null;
                    const pct = typeof total === "number" && total > 0 ? Math.max(2, (total / maxCount) * 100) : 0;
                    return (
                      <li key={name} className="grid grid-cols-[8rem_1fr_4rem] items-center gap-3 text-sm">
                        <span className="truncate text-foreground">{name}</span>
                        <span className="h-2 overflow-hidden rounded-full bg-muted">
                          <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                        </span>
                        <span className="text-right font-mono text-muted-foreground tabular-nums">
                          {typeof total === "number" ? total.toLocaleString() : "n/a"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </section>

          {breakdowns.length > 0 && (
            <section>
              <Card>
                <CardHeader>
                  <CardTitle>Status breakdown</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    {breakdowns.map((b) => {
                      const known = b.options.filter((o): o is { option: string; count: number } => typeof o.count === "number");
                      const breakdownTotal = Math.max(
                        1,
                        known.reduce((sum, o) => sum + o.count, 0),
                      );
                      return (
                        <div key={b.entityName}>
                          <h3 className="mb-2 text-sm font-medium text-foreground">
                            {b.entityName} <span className="font-normal text-muted-foreground">· {b.field}</span>
                          </h3>
                          <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted">
                            {b.options.map((o) =>
                              typeof o.count === "number" && o.count > 0 ? (
                                <span
                                  key={o.option}
                                  className="block h-full"
                                  style={{
                                    width: `${(o.count / breakdownTotal) * 100}%`,
                                    backgroundColor: `var(--status-${roleForValue(o.option)}-dot)`,
                                  }}
                                  title={`${o.option}: ${o.count}`}
                                />
                              ) : null,
                            )}
                          </div>
                          <ul className="mt-2 flex flex-wrap gap-3 text-xs text-foreground">
                            {b.options.map((o) => (
                              <li key={o.option} className="flex items-center gap-1.5">
                                <span
                                  className="size-2 shrink-0 rounded-sm"
                                  style={{ backgroundColor: `var(--status-${roleForValue(o.option)}-dot)` }}
                                />
                                {o.option}
                                <span className="font-mono text-muted-foreground tabular-nums">
                                  {typeof o.count === "number" ? o.count : "n/a"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </section>
          )}

          {trend && (
            <section>
              <Card>
                <CardHeader>
                  <CardTitle>
                    {trend.entityName}: created in the last {TREND_DAYS} days
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div
                    className="flex h-18 items-end gap-1"
                    role="img"
                    aria-label={`Daily ${trend.entityName} record counts over the last ${TREND_DAYS} days`}
                  >
                    {trend.points.map((p) => (
                      <div key={p.date} className="flex h-full flex-1 items-end" title={`${p.date}: ${p.count}`}>
                        <div
                          className="w-full rounded-t-sm bg-primary"
                          style={{ height: `${Math.max(2, (p.count / maxTrendCount) * 100)}%` }}
                        />
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </section>
          )}

          {recent.length > 0 && (
            <section>
              <Card>
                <CardHeader>
                  <CardTitle>Recent records</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="flex flex-col">
                    {recent.map((r) => (
                      <li
                        key={`${r.entityName}-${r.id}`}
                        className="grid grid-cols-[7rem_1fr_auto] items-center gap-3 border-b border-border py-2 text-sm last:border-b-0"
                      >
                        <span className="font-mono text-[11px] tracking-wide text-primary uppercase">{r.entityName}</span>
                        <span className="truncate text-foreground">{r.label}</span>
                        <span className="text-right font-mono text-muted-foreground tabular-nums whitespace-nowrap">
                          {new Date(r.timestamp).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </section>
          )}
        </>
      )}
    </div>
  );
}
