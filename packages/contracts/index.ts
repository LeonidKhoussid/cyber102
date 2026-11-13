export const categories = {
  concert: 'Концерты', theatre: 'Спектакли', exhibition: 'Выставки',
  festival: 'Фестивали', cinema: 'Кино', tour: 'Экскурсии', other: 'Другие события',
} as const;

export type Category = keyof typeof categories;
export type EventStatus = 'published' | 'draft' | 'cancelled';

export type EventDetails = {
  title: string; category: Category; startsAt: string; endsAt?: string; city: string; venue: string;
  address?: string; description?: string; priceMin?: number; priceMax?: number; ageLimit?: number;
  language?: string; latitude?: number; longitude?: number; imageUrl?: string; ticketUrl?: string; status: EventStatus;
};

export type CatalogEvent = EventDetails & {
  id: string;
  sources: { name: string; url: string; verifiedAt?: string }[];
};

export type EventPage = { events: CatalogEvent[]; page: number; limit: number; total: number };
export type Subscription = { city: string; category: Category };
export type Directories = {
  cities: string[];
  venues: { city: string; name: string }[];
  categories: { id: Category; label: string }[];
};
export type QueryValues = Record<string, string | undefined>;

export type DiscoveryContext = {
  city?: string; category?: Category; date?: string; period?: 'today' | 'tomorrow' | 'weekend' | 'week';
  latestEnd?: string; earliestStart?: string; childAge?: number; child?: boolean; partySize?: number;
  budget?: number; travelMinutes?: number; origin?: string; free?: boolean; cheaperThan?: number; referencePrice?: number; seenEventIds?: string[]; query?: string;
};

export type DiscoveryResponse = {
  status: 'matches' | 'clarify' | 'no_results';
  message: string;
  constraints: { label: string; value: string }[];
  events: { event: CatalogEvent; reasons: string[] }[];
  suggestions: string[];
  context: DiscoveryContext;
};
