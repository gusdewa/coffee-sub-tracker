# Deployment

Every deployment — infrastructure, API, Pages and roster seeding — runs through
GitHub Actions authenticating to Azure by OIDC federation. Nothing is deployed
from a workstation, and no Azure credential is ever stored in the repository.

The only thing bootstrapped by hand is the Azure↔GitHub trust itself, which is
already done (see *Bootstrapped* below).

## 1. Repository

Create `gusdewa/coffee-sub-tracker` (private is fine), then:

```sh
git remote add origin https://github.com/gusdewa/coffee-sub-tracker.git
git push -u origin main
```

`github.com` is reachable on the corporate network, so the push works even
though `api.github.com` is not.

## 2. Protected environment

Create an environment named **`production`** (Settings → Environments) and add
required reviewers. Every deploy job targets it, so infrastructure changes,
API releases and roster writes all pause for approval.

### Secrets (Settings → Environments → production → Secrets)

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID` | `<set as AZURE_CLIENT_ID>` |
| `AZURE_TENANT_ID` | `<set as AZURE_TENANT_ID>` |
| `AZURE_SUBSCRIPTION_ID` | `<set as AZURE_SUBSCRIPTION_ID>` |
| `AZURE_DEPLOY_PRINCIPAL_ID` | `<set as AZURE_DEPLOY_PRINCIPAL_ID>` |

These are identifiers rather than credentials — the trust is the federated
credential, and there is no client secret to leak — but they are kept as
environment secrets so the approval gate applies to them.

### Variables (Settings → Environments → production → Variables)

The Firebase web config identifies the project and authorises nothing, so it
belongs in variables, and it is compiled into a public bundle either way.

| Variable | Value |
|---|---|
| `VITE_FIREBASE_PROJECT_ID` | `srx-co-id` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `srx-co-id.firebaseapp.com` |
| `VITE_FIREBASE_APP_ID` | `1:137337108224:web:cbcca641c903d85b5d65e5` |
| `VITE_FIREBASE_API_KEY` | *from `firebase apps:sdkconfig WEB 1:137337108224:web:cbcca641c903d85b5d65e5`* |
| `VITE_ALLOWED_EMAIL_DOMAIN` | `srx.co.id` |
| `VITE_API_BASE_URL` | `https://simo-digitalassets-svc-coffee-sub.azurewebsites.net` |

Also enable Pages: Settings → Pages → Source → **GitHub Actions**.

## 3. Run the workflows, in order

| # | Workflow | What it does |
|---|---|---|
| 1 | **Deploy infrastructure** | `what-if`, then applies `infra/main.bicep` — tables, Key Vault, the web app, and every role assignment |
| 2 | **Deploy API** | tests, builds, publishes to App Service, and **overwrites any earlier content** |
| 3 | **Deploy web to GitHub Pages** | builds with the variables above and publishes |
| 4 | **Seed roster** | dispatch with the real addresses; leave *dry run* on for the first pass |

Infrastructure must run first: the API's managed identity currently has **no**
table role assignments, because they were deliberately removed so the Bicep
owns them. Until step 1 succeeds, the API cannot read or write any table.

The app is currently **stopped**, on purpose — an interrupted local deploy left
content on it that does not correspond to any reviewed run. Step 2 replaces
that content and starts the app.

## 4. Seeding the roster

Dispatch **Seed roster** with a JSON array. Addresses are typed into the
dispatch form, so they never enter the repository:

```json
[
  {"email": "…@srx.co.id", "displayName": "Dewa",   "role": "admin"},
  {"email": "…@srx.co.id", "displayName": "Andri"},
  {"email": "…@srx.co.id", "displayName": "Roy"},
  {"email": "…@srx.co.id", "displayName": "Albert"},
  {"email": "…@srx.co.id", "displayName": "Hadid"},
  {"email": "…@srx.co.id", "displayName": "Derian"}
]
```

Run it with **dry run** first — it validates the domain, rejects duplicates,
and refuses a roster with no admin, printing the plan without writing. The job
logs only the local part of each address.

Re-running is safe: an address already present keeps its member id, so a
re-seed never orphans a ledger partition.

## 5. Firebase Console — the one manual boundary

In project `srx-co-id` (no CLI equivalent exists for either):

1. **Authentication → Sign-in method** → enable **Google**.
2. **Authentication → Settings → Authorized domains** → add `gusdewa.github.io`.

Sign-in fails until both are done.

### Optional: QA links

QA link redemption needs a Firebase service-account key. Project Settings →
Service Accounts → *Generate new private key*, then:

```sh
az keyvault secret set --vault-name kv-simo-coffeesub-dev \
  --name firebase-sa-json --file <downloaded.json>
```

Use `--file`, never `--value`, so the key does not enter shell history. Delete
the download afterwards. Everything except QA redemption works without it; the
deploy workflow warns rather than failing.

## Bootstrapped already

Done by hand because a pipeline cannot create the trust it authenticates with:

- App registration `gh-coffee-sub-deploy` and its service principal
- Federated credentials for `ref:refs/heads/main`, `environment:production`, `pull_request`
- `Contributor` on `rg-simocommondigitalassets-dev-in`
- `Role Based Access Control Administrator` on the same group, **conditioned** so
  it may only assign the three role definitions the Bicep declares
- Firebase web app registration `Coffee Sub Tracker`

`Contributor` at resource-group scope is broader than ideal — that group also
holds the thirteen other digital-assets apps, because the Bicep adds tables and
diagnostics to the shared storage account. Narrowing it to per-resource roles is
a reasonable follow-up.

## Acceptance

A deployment counts as done when there is a green Actions run and the Azure
deployment record names the Actions OIDC principal:

```sh
az deployment group list -g rg-simocommondigitalassets-dev-in \
  --query "[?starts_with(name,'coffee-infra')].{name:name,state:properties.provisioningState,at:properties.timestamp}" -o table

az webapp log deployment show -n simo-digitalassets-svc-coffee-sub \
  -g rg-simocommondigitalassets-dev-in
```

A 200 from `/api/health` is not sufficient on its own — that is exactly what the
unreviewed local build produced.
