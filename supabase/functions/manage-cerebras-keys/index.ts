import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Action = 'add' | 'delete' | 'list' | 'rotate';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const body = await req.json() as { action: Action; key?: string; label?: string; id?: string };
    const { action } = body;

    if (action === 'add') {
      const { key, label } = body;
      if (!key) throw new Error('key is required for add action');

      // Count existing keys to generate label if not provided
      const { count } = await supabase.from('cerebras_keys').select('*', { count: 'exact', head: true });
      const keyLabel = label || `Key ${(count ?? 0) + 1}`;

      const { data, error } = await supabase
        .from('cerebras_keys')
        .insert({
          key_value: key,
          label: keyLabel,
          usage_count: 0,
          success_count: 0,
          fail_count: 0,
          is_active: true,
        })
        .select('id, label, usage_count, success_count, fail_count, is_active, created_at')
        .single();

      if (error) throw error;

      return new Response(JSON.stringify({ ok: true, key: data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    if (action === 'delete') {
      const { id } = body;
      if (!id) throw new Error('id is required for delete action');

      const { error } = await supabase.from('cerebras_keys').delete().eq('id', id);
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    if (action === 'list') {
      const { data, error } = await supabase
        .from('cerebras_keys')
        .select('id, label, usage_count, success_count, fail_count, last_used_at, is_active, created_at')
        .order('created_at', { ascending: true });

      if (error) throw error;

      return new Response(JSON.stringify({ ok: true, keys: data }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    if (action === 'rotate') {
      // Returns the least-used active key for use in inference
      const { data: keys, error } = await supabase
        .from('cerebras_keys')
        .select('id, key_value, usage_count')
        .eq('is_active', true)
        .order('usage_count', { ascending: true })
        .limit(1);

      if (error) throw error;
      if (!keys || keys.length === 0) throw new Error('No active Cerebras API keys configured.');

      const selected = keys[0];

      // Increment usage count
      await supabase
        .from('cerebras_keys')
        .update({ usage_count: selected.usage_count + 1, last_used_at: new Date().toISOString() })
        .eq('id', selected.id);

      return new Response(JSON.stringify({ ok: true, key: selected.key_value, keyId: selected.id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      });
    }

    throw new Error(`Unknown action: ${action}`);
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
