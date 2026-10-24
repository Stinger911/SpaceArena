import type { Sim } from '../game/sim';
import type { ShipInput, SimEvent } from '../game/types';

export type NetStatus = 'waiting' | 'playing' | 'ended';

/** Общий интерфейс сетевого боя для main.ts: хост и клиент выглядят одинаково. */
export interface NetSession {
  readonly role: 'host' | 'client';
  readonly status: NetStatus;
  /** причина завершения: 'host-left' | 'late' | 'lost' */
  readonly endReason: string | null;
  /** null, пока бой не начался */
  readonly sim: Sim | null;
  readonly members: string[];
  onChange: () => void;
  /** фиксированный шаг 1/60 с */
  step(dt: number, input: ShipInput): void;
  drainEvents(): SimEvent[];
  close(): void;
  /** для отладочного оверлея */
  debug(): Record<string, number | string>;
}
