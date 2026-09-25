<!-- Status vocabulary at the public Base package boundary, nested below an
     appearance scope owned entirely by the consumer. -->
<script lang="ts">
  import { Badge, Indicator, StatusIndicator } from "@reddb-io/design-system/base";
</script>

<div
  data-appearance-scope
  data-theme="marketing"
  data-color-scheme="dark"
  data-density="compact"
>
  <Badge variant="primary">Stable</Badge>
  <StatusIndicator label="Available" status="success" />
  <Indicator position="top-end">
    {#snippet marker()}<StatusIndicator label="Delayed" status="warning" showLabel={false} />{/snippet}
    <a href="/service">Service</a>
  </Indicator>
</div>
