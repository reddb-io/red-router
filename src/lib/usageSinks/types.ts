export interface UsageDeliveryStats {
  pending: number;
  delivered: number;
  dead: number;
}

export const EMPTY_DELIVERY_STATS: UsageDeliveryStats = { pending: 0, delivered: 0, dead: 0 };
