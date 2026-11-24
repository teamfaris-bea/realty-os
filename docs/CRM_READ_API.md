# CRM read API

Read-only HTTP API for a sync that today reads Follow Up Boss and, after cutover, reads Realty OS instead. It is shaped like the collections that sync already walks: people, activities, deals, users and stages. Nothing under `/api/crm/v1` writes.

Synthetic examples only. A real token is minted by an Owner in a deployment and is not stored in this repository.

## Authentication

```
Authorization: Bearer ros_<43 base64url characters>
```

The token is created by the Owner (`crm_read.manage`, re-authenticated within 15 minutes):

```
POST /api/crm-read/tokens
{ "name": "Prducer sync" }
```

The response includes `token` once. Later `GET /api/crm-read/tokens` returns `id`, `name`, `prefix`, `createdAt` and `revokedAt`. The prefix is the first ten characters. The database stores sha256 of the whole token and nothing else of the secret.

```
POST /api/crm-read/tokens/:id/revoke
```

Revocation is final. The next request with that bearer token is `401 UNAUTHENTICATED`, the same body as an unknown token. There is no cache.

An Admin, an agent, or a caller with no bearer token cannot use these routes. A token is not accepted as a query parameter.

The read runs as the system actor of the token's tenant. It sees that tenant's rows and no other tenant. It does not impersonate the Owner, so commission (`deal_financials`) is not on this API.

## Paging

Every collection except stages takes:

| Query | Meaning |
|---|---|
| `limit` | 1–100, default 100 |
| `cursor` | opaque token from the previous page's `_metadata.next` |
| `updatedSince` | ISO-8601 instant with an offset (`2024-06-01T00:00:00.000Z`). Rows whose `updated` is at or after this instant |

Order is `updated` ascending, then id. The cursor is the last row already returned, so two rows with the same clock are not skipped or repeated. `_metadata.next` is `null` on the last page.

```
GET /api/crm/v1/people?limit=100&updatedSince=2024-06-01T00:00:00.000Z
```

```json
{
  "people": [],
  "_metadata": { "collection": "people", "limit": 100, "next": null, "updatedSince": "2024-06-01T00:00:00.000Z" }
}
```

Pass `_metadata.next` back as `cursor` until it is null. A later sync passes the newest `updated` it has stored as `updatedSince`.

Stages are a full snapshot (eight person stages, six deal stages). `updatedSince` at or before the label clock returns them all; a later instant returns an empty list. `pipeline=people` or `pipeline=deals` filters that list. `next` is always null.

## People

`GET /api/crm/v1/people` and `GET /api/crm/v1/people/:id`

Deleted people and people who were merged into someone else are omitted. A missing or other-tenant id is `404`.

```json
{
  "id": "018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
  "created": "2024-06-01T15:04:05.123456Z",
  "updated": "2024-06-02T15:04:05.123456Z",
  "name": "Ada Lovelace",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "stage": "active",
  "source": null,
  "sourceId": null,
  "assignedUserId": "018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5c",
  "contacted": false,
  "emails": [{ "value": "ada@example.test", "type": "other", "status": "active", "isPrimary": true }],
  "phones": [{ "value": "+12015550100", "type": "mobile", "status": "active", "isPrimary": true }],
  "addresses": [{ "type": "home", "street": "1 Synthetic Lane", "street2": null, "city": "Testville", "state": "NY", "code": "10001", "country": "US" }],
  "tags": []
}
```

`stage` is one of `new`, `attempting`, `connected`, `nurture`, `active`, `under_contract`, `closed`, `lost`. `assignedUserId` is set when the person is owned. Fair-housing attributes and the import blob are not in this object.

## Activities

`GET /api/crm/v1/events` and `GET /api/crm/v1/events/:id`

`type` filters to `call`, `text`, `email`, `note` or `appointment`. Texts are SMS and MMS. An id looks like `call_<uuid>`. Every activity uses the same object; fields that do not apply to that kind are null. Bodies, subjects and phone numbers are included because a sync stores them. Recordings are not.

```json
{
  "id": "text_018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5d",
  "type": "text",
  "created": "2024-06-01T15:04:05.123456Z",
  "updated": "2024-06-01T15:04:05.123456Z",
  "occurredAt": "2024-06-01T15:04:05.123456Z",
  "personId": "018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b",
  "userId": null,
  "dealId": null,
  "direction": "inbound",
  "subject": null,
  "body": "Can we see the house Thursday?",
  "from": "+12015550199",
  "to": "+12015550100",
  "phone": null,
  "outcome": null,
  "status": "received",
  "appointmentKind": null,
  "startsAt": null,
  "endsAt": null,
  "location": null,
  "durationSeconds": null,
  "activityKind": null
}
```

The list key is `events`.

## Deals

`GET /api/crm/v1/deals` and `GET /api/crm/v1/deals/:id`

```json
{
  "id": "018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5e",
  "name": "Ada purchase",
  "created": "2024-06-01T15:04:05.123456Z",
  "updated": "2024-06-01T15:04:05.123456Z",
  "status": "prospect",
  "stageId": "prospect",
  "side": "buy",
  "price": 450000,
  "priceCents": 45000000,
  "projectedCloseDate": null,
  "closedAt": null,
  "people": [{ "id": "018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b", "role": "buyer" }],
  "users": [{ "id": "018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5c", "role": "owner" }]
}
```

`price` is dollars. `priceCents` is the stored integer. `status` and `stageId` are the deal stage: `prospect`, `agreement_signed`, `active`, `under_contract`, `closed`, `lost`. Commission splits are not included.

## Users

`GET /api/crm/v1/users` and `GET /api/crm/v1/users/:id`

Memberships of the token's tenant, including suspended and removed members so a sync can deactivate them. `id` is the user id. Password hashes, MFA secrets and alert phones are not included.

```json
{
  "id": "018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5c",
  "name": "Olivia Owner",
  "email": "owner@example.test",
  "role": "owner",
  "status": "active",
  "acceptingLeads": true,
  "created": "2024-06-01T15:04:05.123456Z",
  "updated": "2024-06-01T15:04:05.123456Z"
}
```

## Stages

`GET /api/crm/v1/stages`

```json
{
  "id": "active",
  "name": "Hot",
  "pipeline": "people",
  "order": 5,
  "updated": "2024-06-02T15:04:05.123456Z"
}
```

`id` is the stable stage key. `name` is the tenant's label when the Owner has set one, otherwise a title-case of the key. Person stages are the eight keys above. Deal stages are the six deal keys. `updated` is the later of the tenant's creation and the settings clock, so a label change refreshes the whole list.

## Errors

The body is `{ "error": { "code", "requestId" } }`.

| Situation | Status | Code |
|---|---|---|
| Missing, unknown or revoked token | 401 | `UNAUTHENTICATED` |
| Person, event, deal or user not in this tenant | 404 | `NOT_FOUND` |
| Bad cursor, bad `updatedSince`, or an extra query parameter | 422 | `VALIDATION_FAILED` |
| Owner's re-auth is older than 15 minutes (token routes only) | 401 | `REAUTH_REQUIRED` |
| A role other than Owner calls a token route | 404 | `NOT_FOUND` |
