{{/*
The chart's names, labels and the checks that stop an unsafe or inconsistent set of values.
*/}}

{{- define "pinwall.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The name of the chart's objects: the release name, with the chart name added unless it is in it. */}}
{{- define "pinwall.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The name of the metrics Service, short enough to stay under the 63-character limit. */}}
{{- define "pinwall.metricsServiceName" -}}
{{- printf "%s-metrics" (include "pinwall.fullname" . | trunc 54 | trimSuffix "-") -}}
{{- end -}}

{{- define "pinwall.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pinwall.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "pinwall.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "pinwall.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "pinwall.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "pinwall.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The port the web app listens on in the image. */}}
{{- define "pinwall.httpPort" -}}8080{{- end -}}

{{/* Where the secret files are mounted. */}}
{{- define "pinwall.secretsDir" -}}/run/secrets/pinwall{{- end -}}

{{/*
The variables that hold a secret, as the server's configuration catalog marks them. They reach
the pod only as files. `pnpm chart:check` keeps this list equal to the catalog.
*/}}
{{- define "pinwall.secretNames" -}}
PINWALL_SECRET_KEY PINWALL_DATABASE_URL PINWALL_S3_ACCESS_KEY_ID PINWALL_S3_SECRET_ACCESS_KEY PINWALL_OIDC_CLIENT_SECRET
{{- end -}}

{{/*
The image: the digest when there is one, otherwise repository:tag, otherwise an error.
*/}}
{{- define "pinwall.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else if .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository (toString .Values.image.tag) -}}
{{- else -}}
{{- fail "set image.digest (released charts carry it) or image.tag" -}}
{{- end -}}
{{- end -}}

{{/*
An env value as text. Helm reads a YAML number as a float, which would print 95000000 as
9.5e+07, so a whole number is written out in full.
*/}}
{{- define "pinwall.envValue" -}}
{{- if and (kindIs "float64" .) (eq (floor .) .) -}}
{{- printf "%.0f" . -}}
{{- else -}}
{{- . -}}
{{- end -}}
{{- end -}}

{{/*
Stops the render, with a message that says what to change, for values that would put a secret in
the pod spec or leave the chart inconsistent. The Deployment includes it.
*/}}
{{- define "pinwall.validate" -}}
{{- $secrets := regexSplit "\\s+" (include "pinwall.secretNames" . | trim) -1 -}}
{{- $reserved := dict "PINWALL_PUBLIC_ORIGIN" "publicOrigin" "PINWALL_METRICS_PORT" "metrics.enabled and metrics.port" "PINWALL_PORT" "service.port (the container always listens on 8080)" "PINWALL_DATA_DIR" "persistence (the data volume is always /data)" -}}
{{- range $name, $_ := .Values.env -}}
{{- $secret := trimSuffix "_FILE" $name -}}
{{- if has $secret $secrets -}}
{{- fail (printf "set %s through existingSecret and secretFiles, not env" $secret) -}}
{{- end -}}
{{- if hasKey $reserved $name -}}
{{- fail (printf "%s is set by the chart; use %s" $name (get $reserved $name)) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.secretFiles (not .Values.existingSecret) -}}
{{- fail "secretFiles needs existingSecret, the name of the Secret that holds the keys" -}}
{{- end -}}
{{- if and .Values.existingSecret (not .Values.secretFiles) -}}
{{- fail "existingSecret is set but secretFiles is empty: map each secret variable to a key of the Secret, for example PINWALL_SECRET_KEY: secret-key" -}}
{{- end -}}
{{- range $name, $_ := .Values.secretFiles -}}
{{- if not (has $name $secrets) -}}
{{- fail (printf "secretFiles.%s is not a secret variable; the secret variables are %s" $name (join ", " $secrets)) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.metrics.enabled (eq (int .Values.metrics.port) (int (include "pinwall.httpPort" .))) -}}
{{- fail (printf "metrics.port must differ from the web port, %s" (include "pinwall.httpPort" .)) -}}
{{- end -}}
{{- if and .Values.metrics.serviceMonitor.enabled (not .Values.metrics.enabled) -}}
{{- fail "metrics.serviceMonitor.enabled needs metrics.enabled" -}}
{{- end -}}
{{- end -}}
