# Email Send Application

A simple full-stack Node.js application to login with Google and send one email to many recipients from the logged-in Gmail account.

## Setup

1. Copy `.env.example` to `.env`.
2. Create a Google OAuth Client ID and Client Secret.
3. Add this authorized redirect URI in Google Cloud:

```text
http://localhost:3000/auth/google/callback
```

4. Fill `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.
5. Start the app:

```bash
npm start
```

6. Open `http://localhost:3000`.

## Google OAuth Setup

In Google Cloud Console:

1. Create or select a project.
2. Configure the OAuth consent screen.
3. Create an OAuth 2.0 Client ID for a Web application.
4. Add the redirect URI shown above.
5. Add your Gmail address under OAuth consent screen test users while the app is in Testing mode.
6. Copy the client ID and client secret into `.env`.

If Google shows `access_denied` and says the app has not completed verification, add the Gmail account you are trying to login with as a test user in the OAuth consent screen.

## Gmail Permission

The app uses Gmail API send-only permission:

```text
https://www.googleapis.com/auth/gmail.send
```

Google will still show a permission page the first time a user logs in. To remove the unverified-app warning for public users, complete Google verification in Google Cloud.

## Recipient Format

You can enter multiple emails separated by commas, spaces, or new lines.
