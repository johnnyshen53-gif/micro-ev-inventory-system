import {handleAdmin} from '../_shared/staff-auth.ts';
import {dependencies} from '../_shared/staff-runtime.ts';
Deno.serve(request=>handleAdmin(request,dependencies()));
