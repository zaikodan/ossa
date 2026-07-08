import type { ReactionDto } from './conversations.dto';

/** Reação crua (linha do banco) — só o que a agregação precisa. */
export interface RawReaction {
  emoji: string;
  userId: string;
}

/**
 * Agrega reações por emoji do ponto de vista de um viewer: contagem por emoji
 * e se o viewer reagiu (`mine`). Pura (sem I/O) → fácil de testar.
 */
export function aggregateReactions(
  reactions: RawReaction[] | undefined,
  viewerId: string,
): ReactionDto[] {
  if (!reactions?.length) return [];
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions) {
    const cur = byEmoji.get(r.emoji) ?? { count: 0, mine: false };
    cur.count += 1;
    if (r.userId === viewerId) cur.mine = true;
    byEmoji.set(r.emoji, cur);
  }
  return [...byEmoji.entries()].map(([emoji, v]) => ({ emoji, ...v }));
}
