{{- define "wicklee.fullname" -}}
{{- .Release.Name | trunc 53 | trimSuffix "-" -}}
{{- end -}}

{{- define "wicklee.labels" -}}
app.kubernetes.io/name: wicklee
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "wicklee.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
postgres://wicklee:{{ required "postgresql.password is required when postgresql.enabled" .Values.postgresql.password }}@{{ include "wicklee.fullname" . }}-postgres:5432/wicklee
{{- else -}}
{{ required "externalDatabaseUrl is required when postgresql.enabled=false" .Values.externalDatabaseUrl }}
{{- end -}}
{{- end -}}
