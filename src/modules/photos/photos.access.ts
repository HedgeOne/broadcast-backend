import { sql, type SQL } from "drizzle-orm";

// Who may see a user's profile photo, as one SQL rule shared by every
// response that carries a user's photo and by the download endpoint:
//   - the user themself, always;
//   - anyone else only while the account is active, the owner's
//     visibility is 'everyone', and neither has blocked the other.
// `owner` is the users row alias (e.g. sql`u`), `viewerId` the caller.
export function photoVisible(owner: SQL, viewerId: string): SQL {
  return sql`(
    ${owner}.id = ${viewerId}
    OR (
      ${owner}.status = 'active'
      AND COALESCE(
        (SELECT ps.profile_photo_visibility FROM privacy_settings ps WHERE ps.user_id = ${owner}.id),
        'everyone'
      ) = 'everyone'
      AND NOT EXISTS (
        SELECT 1 FROM blocked_users b
        WHERE (b.user_id = ${owner}.id AND b.blocked_user_id = ${viewerId})
           OR (b.user_id = ${viewerId} AND b.blocked_user_id = ${owner}.id)
      )
    )
  )`;
}

// The user's photo version as `viewerId` may see it: the current photo's
// upload id, or NULL when there is no photo or it is hidden from them.
// Clients use it as a cache key and fetch the image through
// GET /users/:userId/photo.
export function photoIdFor(owner: SQL, viewerId: string): SQL {
  return sql`CASE WHEN ${owner}.photo_upload_id IS NOT NULL AND ${photoVisible(owner, viewerId)}
    THEN ${owner}.photo_upload_id END`;
}
