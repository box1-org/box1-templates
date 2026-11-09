# ${{ values.name }}

${{ values.description }}

Code-only Quarkus modules, delivered as the OCI bundle `box1-ci/${{ values.name }}-bundle`
and consumed by `box1-org/${{ values.consumerRepository }}` (`${{ values.consumerPath }}`).
See the repository README for the build, the release pipeline and the bundle layout.

## Bundle layout

```text
{%- for module in values.modules %}
/${{ module }}/quarkus-app/      java -jar /${{ module }}/quarkus-app/quarkus-run.jar
{%- endfor %}
/SHA256SUMS                      sha256 of every file above
```
