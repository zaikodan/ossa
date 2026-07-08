import { aggregateReactions } from './reactions.util';

describe('aggregateReactions', () => {
  it('vazio quando não há reações', () => {
    expect(aggregateReactions([], 'u1')).toEqual([]);
    expect(aggregateReactions(undefined, 'u1')).toEqual([]);
  });

  it('agrupa por emoji e conta', () => {
    const out = aggregateReactions(
      [
        { emoji: '❤️', userId: 'u1' },
        { emoji: '❤️', userId: 'u2' },
        { emoji: '🔥', userId: 'u2' },
      ],
      'u3',
    );
    expect(out).toContainEqual({ emoji: '❤️', count: 2, mine: false });
    expect(out).toContainEqual({ emoji: '🔥', count: 1, mine: false });
  });

  it('marca `mine` para o viewer', () => {
    const out = aggregateReactions(
      [
        { emoji: '❤️', userId: 'u1' },
        { emoji: '❤️', userId: 'viewer' },
      ],
      'viewer',
    );
    expect(out).toEqual([{ emoji: '❤️', count: 2, mine: true }]);
  });
});
