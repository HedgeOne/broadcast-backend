-- Email OTPs are now generated, delivered and checked by the MSG91 OTP
-- widget; the backend only verifies the widget's access token. Our own
-- verification challenges (short-lived code hashes) are no longer used.

DROP TABLE verification_challenges;

DROP TYPE verification_identifier_type;
