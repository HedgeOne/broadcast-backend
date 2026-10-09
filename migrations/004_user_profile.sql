-- Profile details collected during onboarding. display_name already exists;
-- date of birth is a plain calendar date. The minimum age (16) is enforced by
-- the API so it can change without a migration.

ALTER TABLE users ADD COLUMN date_of_birth date;

ALTER TABLE users
  ADD CONSTRAINT users_date_of_birth_range_check
  CHECK (date_of_birth IS NULL OR date_of_birth >= DATE '1900-01-01');
