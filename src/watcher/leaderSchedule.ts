/**
 * Leader-schedule lookahead (Spec §2.2, §3.1).
 *
 * The leader schedule is public and computed in advance for the whole epoch. The Watcher
 * looks ahead to the next K leaders and — critically for Jito — flags which of them are
 * Jito-enabled, because only Jito-enabled leaders can include a bundle (Spec §2.2).
 *
 * Whether a given validator runs Jito is determined by an injected predicate
 * (`isJitoEnabled`), whose real source is Jito's published running-validator set. This
 * keeps the lookahead logic pure and testable while the data source stays swappable.
 *
 * LIVE-INFRA: getSlotLeaders requires a real RPC connection (Spec §7.5).
 */
import type { Connection } from "@solana/web3.js";
import type { LeaderWindow } from "../types.js";

export type JitoEnabledPredicate = (leaderIdentity: string) => boolean;

export interface LeaderScheduleOptions {
  connection: Connection;
  lookahead: number;
  isJitoEnabled: JitoEnabledPredicate;
}

/**
 * Return the next `lookahead` leader windows starting at `fromSlot`, annotated with
 * Jito-enablement. Pure transformation of getSlotLeaders output → LeaderWindow[].
 */
export async function getLeaderLookahead(
  opts: LeaderScheduleOptions,
  fromSlot: number,
): Promise<LeaderWindow[]> {
  const leaders = await opts.connection.getSlotLeaders(fromSlot, opts.lookahead);
  return leaders.map((leaderPk, i) => {
    const leader = leaderPk.toBase58();
    return {
      slot: fromSlot + i,
      leader,
      jitoEnabled: opts.isJitoEnabled(leader),
    };
  });
}

/** The subset of upcoming windows we can actually target with a bundle (Spec §2.2). */
export function jitoTargets(windows: LeaderWindow[]): LeaderWindow[] {
  return windows.filter((w) => w.jitoEnabled);
}
