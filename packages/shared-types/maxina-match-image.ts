// Shared contract for the MAXINA match-card image fallback pipeline.
//
// Both vitana-v1 (frontend + edge functions) and vitana-platform (backend
// services that may proxy or warm the cache) must agree on these types. Any
// change here is a coordinated change across both repos.

export type ProfileImageSource =
  | "uploaded"
  | "imported"
  | "generated"
  | "initials";

export type MatchCoverSource =
  | "uploaded"
  | "generated"
  | "curated_library"
  | "initials";

export type MaxinaCategory = "dance" | "fitness" | "wellness";

export type MaxinaImageType = "avatar" | "cover";

export interface ResolveMatchImagesRequest {
  matchedUserIds: string[];
  category?: MaxinaCategory;
  /** When true, server waits for in-flight Vertex generations before responding. */
  awaitGeneration?: boolean;
}

export interface ResolvedMatchImage {
  userId: string;
  displayName: string | null;
  initials: string;
  fallbackSeed: string | null;
  profileImageUrl: string | null;
  profileImageSource: ProfileImageSource;
  matchCoverImageUrl: string | null;
  matchCoverSource: MatchCoverSource;
}

export interface ResolveMatchImagesResponse {
  matches: ResolvedMatchImage[];
}

export interface GenerateFallbackImageRequest {
  userId: string;
  category?: MaxinaCategory;
  imageType: MaxinaImageType;
  /** Bypass the "already generated" short-circuit. Admin/debug only. */
  force?: boolean;
}

export interface GenerateFallbackImageResponse {
  imageUrl: string;
  source: ProfileImageSource | MatchCoverSource;
  reused: boolean;
  model?: string;
}

/**
 * Profile columns the resolver reads. Mirrors the
 * `profile_match_image_resolution` view in vitana-v1's supabase migration.
 */
export interface ProfileImageColumns {
  user_id: string;
  full_name: string | null;
  display_name: string | null;
  has_uploaded_photo: boolean;
  profile_image_url: string | null;
  profile_image_source: ProfileImageSource | null;
  match_cover_image_url: string | null;
  match_cover_source: MatchCoverSource | null;
  fallback_seed: string | null;
  image_last_generated_at: string | null;
}
