export interface WillhabenListingPreview {
  id: string;
  url: string;
  title: string;
  price: number | null;
  priceText: string | null;
  sizeM2: number | null;
  rooms: number | null;
  address: string | null;
  district: string | null;
  imageUrl: string | null;
}

export interface WillhabenListing extends WillhabenListingPreview {
  postalCode: string | null;
  fullAddress: string | null;
  description: string | null;
  locationDescription: string | null;
  otherDescription: string | null;
  attributes: Record<string, string>;
  equipment: Record<string, string>;
  priceLabel: string | null;
  deposit: number | null;
  depositText: string | null;
  priceInfo: Record<string, string>;
  images: string[];
  landlord: string | null;
  landlordType: string | null;
  contactInfo: string | null;
  lastModified: string | null;
  willhabenCode: string | null;
  heatingInfo: string | null;
  additionalInfoUrls: string[];
}

export interface ScrapeOptions {
  url: string;
  maxPages?: number;
  signal?: AbortSignal;
  onlyNew?: boolean;
}

export interface ScrapeResult {
  listings: WillhabenListing[];
  totalFound: number;
  pagesScraped: number;
  newListings: number;
}
