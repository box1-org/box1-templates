# ${{ values.name }}

${{ values.description }}

Owner: `${{ values.owner }}`. Quarkus 3.40.1.1, Java 21, Maven 3.9.16.

## Local development

Install JDK 21 and use the included Maven wrapper:

```sh
./mvnw quarkus:dev
./mvnw verify -DskipITs=false -Dgit.ref="$(git rev-parse HEAD)"
curl http://localhost:8080/api/greetings?name=Ada
curl http://localhost:8080/api/info
```

Verification runs unit tests, HTTP tests, packaged JVM integration tests,
Checkstyle, and SpotBugs/FindSecBugs. `/api/info` includes the immutable Git SHA
embedded in the image; local builds default to `unknown` unless supplied above.
Java package `org.box1` is deliberately stable across generated services.

## First deployment

1. Open the GitOps onboarding PR linked by Developer Hub. Review and merge it
   after its checks pass. Argo CD discovers `applications/${{ values.name }}.yaml`
   through the root application and installs the manifests and PAC registration into development namespace
   `${{ values.namespace }}`.
2. Wait for the `${{ values.name }}` Argo Application to be Synced/Healthy and the
   PAC Repository to exist in `box1-ci`. The initial Deployment has zero replicas
   and a non-runnable placeholder digest until the first successful release.
3. Push your first application change to `main` (or merge an application PR).
   The repository's initial creation happens before PAC registration, so that
   initial webhook is intentionally not relied upon. To test unchanged code,
   `git commit --allow-empty -m "Start first delivery" && git push origin main`.
4. Tekton tests, Jib builds/pushes a SHA-tagged image, and the central promotion
   Task opens a GitOps PR with its immutable digest. Development merges after
   required exact-head checks. Argo CD activates the Deployment and reconciles it.
   The pipeline observes readiness and smoke-tests the public HTTPS Route.

No developer runs `oc apply` or writes deployment YAML.

Route: https://${{ values.namespace }}.apps.ocp.box1.org

```sh
EXPECTED_GIT_REF="$(git rev-parse HEAD)" python3 scripts/smoke.py \
  https://${{ values.namespace }}.apps.ocp.box1.org
```

## Delivery and configuration

PRs validate without registry credentials. Main releases use centrally managed
Tasks from `box1-gitops/platform/pipelines/tasks`, resolved from `box1-ci`.
GitHub checks link to cluster PipelineRuns named `${{ values.name }}-validate-*`
and `${{ values.name }}-release-*`. Pipelines as Code and Developer Hub use
separate GitHub Apps, both installed for all `box1-org` repositories.

Jib creates JVM images from a digest-pinned UBI 9 / Java 21 runtime without a
Docker daemon. Images use `registry.apps.ocp.box1.org/box1-ci/${{ values.name }}:<SHA>`;
OpenShift pulls by digest through the internal registry service.

`deploy/` is the generated onboarding snapshot for review and local rendering
(`kubectl kustomize deploy`). After onboarding, the GitOps repository is the
authoritative deployment source. Change the Route, probes, resources, or
`GREETING_PREFIX` there. The default smoke contract expects `Hello from box1`.
The ConfigMap also sets JVM container memory limits; runtime has no API token.

Endpoints: `/api/greetings`, `/api/info`, `/q/health/live`, `/q/health/ready`,
`/q/health/started`, `/q/openapi`, `/q/metrics`.

The development promotion policy is automated after checks. Other environments
need explicit platform configuration and approval. Static analysis is included;
no external dependency CVE database scan is implied.

## API documentation and endpoint testing

Developer Hub populates **Provides APIs** with `${{ values.name }}-api`.
Open the API's **Definition** tab to browse the deployed OpenAPI contract and use
**Try it out**. The catalog reads `https://${{ values.namespace }}.apps.ocp.box1.org/q/openapi`,
so the API entity becomes available after the first successful deployment.
Swagger UI is also available at `https://${{ values.namespace }}.apps.ocp.box1.org/q/swagger-ui/`.
The production contract targets the public HTTPS Route; override `PUBLIC_API_URL`
when deploying behind another public address. CORS allows the Developer Hub
origin to make tester requests without cookies. API authentication, if added,
should be declared in the OpenAPI contract and supplied through **Authorize**.
