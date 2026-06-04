# ECR Auth Bootstrap — fixing "no basic auth credentials" on a prod EC2

> **Symptom you're seeing in the deploy log:**
> ```
> Image .../...:production-9932c6a Pulling
> Image .../...:production-9932c6a Error failed to resolve reference:
>   pull access denied, repository does not exist or may require
>   authorization: authorization failed: no basic auth credentials
> ```
>
> This is **always** the same root cause: the EC2 has no working
> credential helper for ECR, so `docker pull` falls through to anonymous
> and ECR rejects it. The image exists; the box can't prove who it is.

---

## What needs to be true on the box

The Docker daemon must be able to obtain a fresh ECR auth token on
demand. The deployed pattern (matches QA's working host) is:

1. **EC2 instance profile** has an IAM role attached.
2. That IAM role has the **`AmazonEC2ContainerRegistryReadOnly`** AWS
   managed policy attached (or a tighter custom policy granting
   `ecr:GetAuthorizationToken` + `ecr:BatchGetImage` +
   `ecr:GetDownloadUrlForLayer` on the relevant ECR repos).
3. **`amazon-ecr-credential-helper`** is installed on the box.
4. `~/.docker/config.json` (or `/root/.docker/config.json` for the
   user that owns the docker-compose invocation) contains:
   ```json
   {
     "credHelpers": {
       "902810393464.dkr.ecr.ap-south-1.amazonaws.com": "ecr-login"
     }
   }
   ```

If any one of the four is missing, `docker pull` errors with the
"no basic auth credentials" message you're seeing.

---

## Diagnose (run via SSM on the failing EC2)

Console → Systems Manager → Session Manager → Start session → pick the
prod BE EC2. Then run:

```bash
# 1. IAM role + policies attached to the instance profile
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/iam/info
# Look for "InstanceProfileArn": "...EasyFixProdInstanceProfile" (or similar)
# If output is empty / missing, the box has NO IAM role attached — that's the bug.

# 2. ecr-login helper present?
which docker-credential-ecr-login
# Expected: /usr/bin/docker-credential-ecr-login (or /usr/local/bin/…)
# Missing: install with the recipe below.

# 3. Docker config wired to use the helper?
cat ~/.docker/config.json 2>/dev/null
sudo cat /root/.docker/config.json 2>/dev/null
# Expected: a "credHelpers" block referencing the ECR registry. If
# neither file has it, the helper isn't being consulted even if it's
# installed.

# 4. Final smoke test — can we get a token at all?
aws ecr get-login-password --region ap-south-1 | head -c 50
# Expected: a JWT-looking blob. If you see "Unable to locate credentials"
# the IAM role isn't reaching Docker / aws-cli.
```

---

## Fix (one-time bootstrap on the prod BE EC2)

### A. Attach the IAM policy (if step 1 above was empty / missing)

Console → IAM → Roles → find the role attached to the prod BE EC2
(or attach a new one via EC2 → Instance → Actions → Security → Modify
IAM role). Add the AWS managed policy:

| Console path | What to add |
|---|---|
| **IAM → Roles → \<your-role\> → Add permissions → Attach policies** | `AmazonEC2ContainerRegistryReadOnly` |

This propagates within ~30 seconds; the next `docker pull` should
see it.

### B. Install `amazon-ecr-credential-helper` (if step 2 above was missing)

```bash
# Amazon Linux 2023 / EL9 family
sudo dnf install -y amazon-ecr-credential-helper

# Amazon Linux 2 / EL7 family
sudo amazon-linux-extras install -y amazon-ecr-credential-helper

# Ubuntu 22.04+
sudo apt-get update && sudo apt-get install -y amazon-ecr-credential-helper

# Verify
docker-credential-ecr-login version
```

### C. Wire docker to USE the helper (if step 3 above was missing)

```bash
# For the user that runs the deploy commands (usually root via SSM):
sudo mkdir -p /root/.docker
sudo tee /root/.docker/config.json > /dev/null <<'EOF'
{
  "credHelpers": {
    "902810393464.dkr.ecr.ap-south-1.amazonaws.com": "ecr-login"
  }
}
EOF
sudo chmod 600 /root/.docker/config.json

# Verify by attempting a pull manually:
sudo docker pull 902810393464.dkr.ecr.ap-south-1.amazonaws.com/easyfix/backend:production-9932c6a
# Expected: "pull complete" — no "no basic auth credentials" line.
```

### D. Re-run the deploy

Once `docker pull` works manually, re-trigger the GitHub Actions
workflow (Actions → EasyFix_Backend deploy → Re-run failed jobs).
The SSM step should now succeed.

---

## Why QA worked and Prod didn't

The QA EC2 was bootstrapped via `deploy/bootstrap-ec2.sh` (or the
`AWS_QA_BOOTSTRAP.md` runbook), which performs steps A–C as part of
its one-time setup. The prod BE EC2 either:

- Was bootstrapped before the helper-install step was added to the
  runbook, OR
- Is a freshly-launched EC2 that skipped the bootstrap script entirely.

Run the same bootstrap script on the new prod box (if it exists in
the repo), or apply steps A–C above by hand.

---

## Once it's working — keep it working

- **IAM role drift**: if someone later detaches the role for any
  reason, the next deploy resurfaces this exact error. Add a CloudWatch
  alarm on `IAM DetachRolePolicy` events for the instance role if you
  want early warning.
- **Helper updates**: `dnf upgrade -y amazon-ecr-credential-helper`
  every few months keeps it current. The protocol is stable; you're
  unlikely to ever HAVE to upgrade.
- **Token expiry**: the helper requests a fresh token on every pull
  (12-hour validity is irrelevant). No cron / refresh job needed.
