# QuickSight Employee Performance — S3 clean-up of superseded snapshots

Each upload writes its own data object under `QuickSight/EmployeePerformance/`
(`data-<uploadedAt>-<rand>.json.gz`, ~0.6 MB) and `meta.json` names the live one.
Old objects are not deleted at upload time: a reader on another instance may
still be loading one. Instead, once the new `meta.json` is written, the backend
tags the object the previous meta named with `superseded=true`, and the
lifecycle rule below expires tagged objects.

**Do not use an age-only rule on the prefix.** The live snapshot is only as new
as the last upload; after 90 days without an upload an age-only rule would
delete it and the Employee tab would 500. The tag filter is what keeps the live
object safe: it is never tagged.

Apply once per bucket (QA and Prod each use the bucket in their
`S3_BUCKET_NAME`).

## 1. Let the backend tag objects

The backend's IAM user/role needs `s3:PutObjectTagging` on the prefix. Without
it uploads still succeed, but a warning is logged (`could not tag the superseded
data object`) and old snapshots are kept rather than expired.

```json
{
  "Effect": "Allow",
  "Action": "s3:PutObjectTagging",
  "Resource": "arn:aws:s3:::<bucket>/QuickSight/EmployeePerformance/*"
}
```

AWS Console → IAM → Users (or Roles) → the backend's identity → Permissions →
its S3 policy → Edit → add the statement above → Save.

## 2. Add the lifecycle rule

AWS Console → S3 → `<bucket>` → Management → Lifecycle rules → Create lifecycle rule:

| Field | Value |
|---|---|
| Rule name | `qs-employee-performance-superseded` |
| Scope | Limit the scope using filters |
| Prefix | `QuickSight/EmployeePerformance/data` |
| Object tags | Key `superseded`, Value `true` |
| Actions | Expire current versions of objects |
| Days after object creation | `90` |

If the bucket has versioning on, also tick **Permanently delete noncurrent
versions** (e.g. 1 day), or expired objects linger as noncurrent versions.

The prefix covers the legacy `data.json.gz` too, which the first upload after
this change tags.

Days count from the object's CREATION, not from tagging: a superseded upload
older than 90 days expires at the next daily lifecycle run, a newer one stays
until it is 90 days old (so recent snapshots remain available for a rollback).

### CLI equivalent

`put-bucket-lifecycle-configuration` REPLACES the bucket's whole lifecycle
configuration. Read it first and merge this rule into the existing `Rules`:

```bash
aws s3api get-bucket-lifecycle-configuration --bucket <bucket>
```

```json
{
  "ID": "qs-employee-performance-superseded",
  "Status": "Enabled",
  "Filter": {
    "And": {
      "Prefix": "QuickSight/EmployeePerformance/data",
      "Tags": [{ "Key": "superseded", "Value": "true" }]
    }
  },
  "Expiration": { "Days": 90 }
}
```

## 3. Verify

After the next upload, the previous data object should carry the tag:

```bash
aws s3api get-object-tagging --bucket <bucket> --key QuickSight/EmployeePerformance/<previous dataKey>
```

and the object named by the current `meta.json` must have NO `superseded` tag.
