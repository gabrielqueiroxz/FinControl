import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ksgofitvvgzmytkoecpd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_uTIzL4oHLOR7SB9toR0Ugg_-DgsvrNe';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);