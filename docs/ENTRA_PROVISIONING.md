# Microsoft 365 / Entra mailbox provisioning — operator runbook

**What this feature does:** when an Admin adds a CRM user (Settings → Manage Users → Add User),
the backend now also creates that person's Microsoft 365 account and assigns a licence, so the
`official_email` on their `tbl_user` row is a mailbox that can actually receive their login OTP.
Every attempt — including a skipped one — is recorded in `tbl_user_entra_provisioning`.

**Why it exists:** before this, `createUser` wrote the `tbl_user` row and stopped. No mailbox was
ever created. Microsoft Graph answers `202 Accepted` to a `sendMail` for an address that does not
exist, so the OTP looked delivered, the WhatsApp/SMS fallback never fired, and the bounce landed in
the sender mailbox nobody reads. Reported case: **user_id 8710 / ankitjha@easyfix.in** (Project
Manager) simply could not log in, and no screen could say why.

> **The feature ships OFF.** `easyfix_properties['entra.provisioning.enabled']` is seeded `'false'`
> and the code also defaults to off, so merging this cannot start creating directory accounts. Steps
> 1–4 below grant the permissions; step 5 is the deliberate switch-on.

---

## 0. Which app registration am I editing?

There is **one** app registration for all Microsoft Graph work in this backend. Its client id is the
value of the env var **`MS_GRAPH_CLIENT_ID`** (see `.env.example`, "Email (Microsoft Graph)"
section — the three real names are `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`,
`MS_GRAPH_CLIENT_SECRET`, plus `MS_GRAPH_SENDER_EMAIL`, default `ithelpdesk@easyfix.in`).

On the servers those live in `/opt/easyfix/backend.env` (see `docs/ENV_VARS.md`).

To find the value:

```bash
grep MS_GRAPH_CLIENT_ID /opt/easyfix/backend.env      # on the backend host
grep MS_GRAPH_TENANT_ID /opt/easyfix/backend.env
```

Copy the client id (a GUID). That GUID — **not** the app's display name — is how you identify the
right registration in the portal; display names are not unique.

---

## 1. Open the app registration

1. Sign in to <https://portal.azure.com> with an account that can consent to application
   permissions (**Global Administrator** or **Privileged Role Administrator** — a plain Application
   Administrator can *add* the permissions but the "Grant admin consent" button will be greyed out
   or will fail).
2. In the top search bar type **Microsoft Entra ID** and open it. (This blade used to be called
   "Azure Active Directory"; if your tenant still shows the old name, it is the same thing.)
3. In the left navigation choose **App registrations**.
4. Select the **All applications** tab (the default tab only shows apps you own).
5. Paste the client id GUID from step 0 into the search box and open the single result.
6. Sanity-check on the **Overview** page: *Application (client) ID* must equal `MS_GRAPH_CLIENT_ID`
   and *Directory (tenant) ID* must equal `MS_GRAPH_TENANT_ID`.

---

## 2. Add the two application permissions

Still inside that app registration:

1. Left navigation → **API permissions**.
2. Click **+ Add a permission**.
3. On the "Request API permissions" panel choose **Microsoft Graph**.
4. Choose **Application permissions** — **NOT** *Delegated permissions*.
   This backend uses the OAuth2 **client-credentials** flow (a daemon with no signed-in user);
   delegated permissions are never evaluated and adding them changes nothing.
5. In the "Select permissions" search box, find and tick:
   - **`User.ReadWrite.All`**
   - **`Organization.Read.All`**
6. Click **Add permissions** at the bottom.

You should now see both rows in the table with **Type = Application** and a **Status** of
*"Not granted for &lt;tenant&gt;"* (usually with an orange/red warning triangle). `Mail.Send` should
already be there and granted — that is the existing email feature; **do not remove it**.

### Why each permission

| Permission | Used for | Where in code |
|---|---|---|
| `User.ReadWrite.All` | `POST /v1.0/users` (create the account), `POST /v1.0/users/{id}/assignLicense` (assign the licence), and the read-only `GET /v1.0/users/{upn}` existence pre-check on the OTP path. It also implicitly covers the read (`User.Read.All`) that the pre-check needs, which is why one grant unlocks both. | `services/entra-provisioning.service.js` |
| `Organization.Read.All` | `GET /v1.0/subscribedSkus` — reads the tenant's subscriptions so the licence SKU can be chosen **by part number** and seat availability checked. Without it the account is created but the licence step reports `failed: could not read subscribed SKUs`, which means **no mailbox**. | `listSubscribedSkus()` |
| `Mail.Send` *(already granted)* | `POST /v1.0/users/{sender}/sendMail` | `services/email.service.js` |

---

## 3. Grant admin consent

1. Back on the **API permissions** page, click **✓ Grant admin consent for &lt;your tenant name&gt;**
   (the button sits just above the permissions table).
2. Confirm the dialog (**Yes**).
3. **Verify:** the **Status** column for both `User.ReadWrite.All` and `Organization.Read.All` must
   read **“Granted for &lt;tenant&gt;”** with a green check mark. If it still shows
   "Not granted", the signed-in account lacks the consent role — get a Global Administrator to
   click the button.

**Propagation:** consent changes usually apply within a minute but can take **up to ~15 minutes**.
Cached access tokens live up to ~60 minutes; this backend caches one per process, so if you want the
change to apply immediately, restart the backend after consent (otherwise just wait — the next
token refresh picks it up).

Until consent lands, Graph answers `403`. That is handled deliberately:

- the OTP mailbox pre-check treats `401/403` as **unknown** and **fails open** (the email is
  attempted exactly as it was before this feature), so nothing regresses while you wait;
- provisioning records `failed` with the reason
  *"Graph denied the call (403) — the app registration is missing admin consent …"* — which is your
  cue that this step has not completed.

---

## 4. Pick the licence SKU

Creating an Entra account does **not** create a mailbox. Exchange Online provisions the mailbox only
once the account holds a licence. So you must tell the backend **which** licence to spend.

The value is a **SKU part number**, never a GUID. Two ways to find it:

- **Microsoft 365 admin centre** → <https://admin.microsoft.com> → **Billing** → **Your products** →
  open a subscription. The part number / "product name (SKU)" is shown on the subscription details
  (e.g. `O365_BUSINESS_ESSENTIALS`, `SPB`, `EXCHANGESTANDARD`, `ENTERPRISEPACK`).
- **Graph** (authoritative, and exactly what the backend reads):
  `GET https://graph.microsoft.com/v1.0/subscribedSkus` — use Graph Explorer
  (<https://developer.microsoft.com/graph/graph-explorer>) and read `value[].skuPartNumber`,
  `value[].prepaidUnits.enabled` and `value[].consumedUnits`. You need a SKU with
  `capabilityStatus: "Enabled"` and `prepaidUnits.enabled − consumedUnits > 0` (a free seat).

Set it in **`easyfix_properties`** (preferred — no redeploy):

```sql
UPDATE easyfix_properties
   SET property_value = 'O365_BUSINESS_ESSENTIALS'      -- your part number
 WHERE property_key   = 'entra.provisioning.sku.part.number';
```

Env fallback (only used when the property row is empty): `MS_GRAPH_LICENSE_SKU_PART_NUMBER`.

If it is unset the flow records `licence_status = 'no_sku_configured'`; if the part number is not on
the tenant it records `sku_not_found` **and lists the SKUs that are**; if every seat is taken it
records `no_seats_available` with the exact count. Those precise reasons are the point — "licence
failed" with no detail is what made the original bug undiagnosable.

---

## 5. Configuration reference + turning it ON

### `easyfix_properties` keys (all seeded by `migrations/2026-07-30-create-tbl-user-entra-provisioning.sql`)

| Key | Seeded | Meaning |
|---|---|---|
| `entra.provisioning.enabled` | `false` | **Master switch for every directory write.** Fail-closed: off (or missing) ⇒ zero Graph calls, and each Add User records `skipped_disabled`. |
| `entra.provisioning.sku.part.number` | *(empty)* | Licence SKU part number from step 4. |
| `entra.managed.domains` | `easyfix.in` | Comma-separated domains this tenant owns. We refuse to provision an address outside them, and the OTP pre-check ignores such addresses (a user signing in with a personal Gmail would always 404 in our directory — suppressing their OTP would lock them out). |
| `login.otp.email.mailbox.precheck` | `true` | The read-only mailbox-existence probe on the OTP email channel. Seeded **on** because it writes nothing and fails open on anything except a clean 404 in a managed domain. Set `false` to disable with no redeploy. A directory object that exists but is **not mail-enabled** (`mail` null, no SMTP `proxyAddresses` — i.e. account created, licence never assigned) resolves to `no_mailbox`: the email is still attempted, but it is **not counted as delivered**, so the WhatsApp/SMS fallback still runs. |
| `access.entraprovision.emails` | *(empty)* | Per-person allowlist for **every** directory write — the manual repair endpoint *and* the provisioning side-effect of Add User (`POST /api/admin/users`), which performs the identical write. Empty = **deny all**. A non-allowlisted Admin can still add CRM users; the mailbox step records `skipped_not_allowed`. |

### Env vars

| Var | Required? | Notes |
|---|---|---|
| `MS_GRAPH_TENANT_ID` / `MS_GRAPH_CLIENT_ID` / `MS_GRAPH_CLIENT_SECRET` | **yes** (already set — the email feature uses them) | Same app registration; one shared token cache. |
| `MS_GRAPH_LICENSE_SKU_PART_NUMBER` | optional | Fallback for the SKU property. |
| `MS_GRAPH_MANAGED_DOMAINS` | optional | Fallback for `entra.managed.domains`. |
| `MS_GRAPH_USAGE_LOCATION` | optional (default `IN`) | ISO-3166 alpha-2 stamped on new accounts. Entra refuses some licence assignments when `usageLocation` is unset. |
| `MS_GRAPH_TIMEOUT_MS` | optional (default `15000`) | Per-Graph-call timeout. |

### Turn the feature on

```sql
-- 1) SKU first, so the very first provisioning actually produces a mailbox.
UPDATE easyfix_properties SET property_value = '<YOUR_SKU_PART_NUMBER>'
 WHERE property_key = 'entra.provisioning.sku.part.number';

-- 2) Who may click the manual (re)provision button.
UPDATE easyfix_properties SET property_value = 'you@easyfix.in,someone.else@easyfix.in'
 WHERE property_key = 'access.entraprovision.emails';

-- 3) The master switch, last.
UPDATE easyfix_properties SET property_value = 'true'
 WHERE property_key = 'entra.provisioning.enabled';
```

Property reads are cached for up to 1 hour. To apply immediately, use the operator reload
(`POST /api/admin/properties/reload`, triggered by the 10-quick-clicks gesture on the EasyFix logo)
or restart the backend.

**To roll back:** set `entra.provisioning.enabled` back to `'false'`. That restores exactly the
pre-2026-07-30 behaviour — no redeploy, no code change. Accounts already created are not touched.

---

## 6. Verification recipe (end to end)

1. **Migration applied.** `npm run verify:migrations` — it lists
   `2026-07-30-create-tbl-user-entra-provisioning.sql` as PENDING until a DBA runs it. Then:
   ```sql
   SHOW CREATE TABLE tbl_user_entra_provisioning;
   SELECT property_key, property_value FROM easyfix_properties
    WHERE property_key LIKE 'entra.%' OR property_key = 'login.otp.email.mailbox.precheck'
       OR property_key = 'access.entraprovision.emails';
   ```
2. **Permissions really landed.** In Graph Explorer, signed in as the tenant admin, run
   `GET /v1.0/subscribedSkus`. If that works for the *app* you will see it in the backend logs as a
   successful licence step; a `403` in the logs means step 3 is incomplete.
3. **Flag still off ⇒ nothing happens.** With `entra.provisioning.enabled = 'false'`, add a throwaway
   user. Expect log line `Entra provisioning skipped (feature off) · userId=…` and:
   ```sql
   SELECT * FROM tbl_user_entra_provisioning WHERE user_id = <new id>;
   -- account_status = 'skipped_disabled', licence_status = 'skipped', attempts = 0
   ```
   This proves the record exists even when nothing was attempted — the discoverability fix.
4. **Flag on ⇒ real mailbox.** Turn it on (step 5) and add a real user with an `@easyfix.in` address.
   Expect:
   - API response: `data.provisioning.accountStatus = 'created'`,
     `licenceStatus = 'assigned'`, `mailboxReady = true`;
   - logs: `Entra account created · upn=… · objectId=…` then `Entra licence assigned · … · sku=…`;
   - `tbl_user_entra_provisioning` row with `entra_object_id` populated;
   - the account visible in <https://admin.microsoft.com> → **Users** → **Active users**, with the
     licence attached. Exchange takes a few minutes to finish provisioning the mailbox.
   - If the response says `mailboxReady = false`, read `provisioning.reason` — it names the exact
     step that failed (no seats, SKU not found, 403, …).
5. **Idempotency.** Call the repair endpoint (below) twice for the same user. The second call must
   report `accountStatus = 'already_exists'` and `licence_status = 'already_licensed'`, with
   `attempts` incremented and **no** second account in Entra.
6. **The OTP path is now honest.** Request an OTP for an `@easyfix.in` address that has no mailbox.
   Expect a `warn` naming the address:
   `login OTP email SUPPRESSED — no Microsoft 365 mailbox exists for "…"` followed by the WhatsApp
   fallback attempt — instead of the old silent "delivered". For the *partial* case (Entra account
   exists but unlicensed) the line reads `OTP email NOT COUNTED AS DELIVERED — "…" has an Entra
   account but no mailbox`, and the fallback runs anyway. If no channel delivers at all,
   `POST /api/auth/login-otp` now answers **502** with the reason instead of "OTP sent".
   *Testing on QA:* with `TEST_EMAILS` set, the probe is skipped entirely (the recipient is rewritten
   to the developer inbox before dispatch, so probing the original address would suppress a send that
   would have worked).

---

## 7. Repairing an existing user (the reported case, user_id 8710)

Nobody should re-create the CRM user — `tbl_user.user_id` is referenced by `tbl_job` audit columns.
Use the repair endpoint. It is **idempotent**: safe to click twice.

**Prerequisites:** you must be role **Admin**, your `official_email` must be listed in
`access.entraprovision.emails`, and `entra.provisioning.enabled` must be `'true'` (otherwise the call
succeeds but records `skipped_disabled`).

```bash
# 1. See the current state (role Admin; no allowlist needed for the read)
curl -s https://<backend-host>/api/admin/users/8710/provisioning \
     -H "authorization: Bearer <admin-jwt>"

# 2. Provision / repair it
curl -s -X POST https://<backend-host>/api/admin/users/8710/provision-mailbox \
     -H "authorization: Bearer <admin-jwt>"
```

Expected success payload:

```json
{
  "success": true,
  "message": "Mailbox is ready (created / assigned)",
  "data": {
    "user_id": 8710,
    "official_email": "ankitjha@easyfix.in",
    "provisioning": {
      "attempted": true,
      "userPrincipalName": "ankitjha@easyfix.in",
      "entraObjectId": "…guid…",
      "accountStatus": "created",
      "licenceStatus": "assigned",
      "skuPartNumber": "O365_BUSINESS_ESSENTIALS",
      "mailboxReady": true
    }
  }
}
```

The response is **200 even when provisioning fails** — you asked us to try, and the payload carries
the precise reason plus `graphRequestId` (quote that id if you open a Microsoft support ticket).

**The temporary password:** the account is created with a strong random password
(`require('crypto')`, never `Math.random`) and `forceChangePasswordNextSignIn: true`. That password
is **never logged, never stored and never returned by the API** — by design. If the user needs to
sign in to Microsoft 365 itself, reset it from
<https://admin.microsoft.com> → **Users** → **Active users** → select the user → **Reset password**.
For EasyFix itself they do not need it at all: EasyFix login is OTP-only, and the mailbox exists so
that the OTP can be received.

### Finding every other broken user

```sql
-- Users whose mailbox was never confirmed
SELECT u.user_id, u.user_name, u.official_email,
       p.account_status, p.licence_status, p.attempts, p.last_error, p.updated_on
  FROM tbl_user u
  LEFT JOIN tbl_user_entra_provisioning p ON p.user_id = u.user_id
 WHERE u.user_type_id = 5
   AND u.user_status  = 1
   AND u.official_email LIKE '%@easyfix.in'
   AND ( p.user_id IS NULL                                   -- never even recorded
      OR p.account_status NOT IN ('created','already_exists')
      OR p.licence_status NOT IN ('assigned','already_licensed') )
 ORDER BY u.user_id DESC;
```

Then POST `/api/admin/users/{user_id}/provision-mailbox` for each. Watch the seat count — each
successful provision consumes one licence seat.

---

## 8. Troubleshooting

| Symptom in `last_error` / logs | Cause | Fix |
|---|---|---|
| `Graph denied the call (403) …` | Admin consent not granted (or not propagated) | Redo step 3; wait ~15 min; restart the backend to drop the cached token |
| `Graph rejected the token (401) …` | `MS_GRAPH_CLIENT_SECRET` expired or rotated | Create a new client secret on the app registration and update `/opt/easyfix/backend.env` |
| `no licence SKU configured` | `entra.provisioning.sku.part.number` empty | Step 4 |
| `skuPartNumber "X" is not present …` | Wrong part number | Use one from the "available" list in the same message |
| `SKU "X" has no free seats (n/n used)` | Out of licences | Buy a seat or free one, then re-POST the repair endpoint |
| `account created … licence assignment failed` | Account exists, **no mailbox** | Read the licence reason; fix; re-POST (idempotent — it will reuse the account) |
| `usageLocation` complaints from Graph | Tenant requires a usage location | Set `MS_GRAPH_USAGE_LOCATION` (default `IN`) and re-run |
| `403 Not authorised — your account is not on the "Provision Microsoft 365 Mailbox" access list` | Your email is not in `access.entraprovision.emails` | Add it, then reload properties |
| `mailbox provisioning is off …` | Master switch off | Step 5 |
| `domain "gmail.com" is not an EasyFix-managed …` | The user's `official_email` is a personal address | Expected — no tenant mailbox is possible. Their OTP goes over WhatsApp/SMS. |
