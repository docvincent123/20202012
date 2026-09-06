import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const runtimeFix = {
  name: 'rehaflow-runtime-fix',
  enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('/src/main2.jsx')) return null;
    let out = code;
    out = out.replace(/getPrescriptions\(\)/g, "apiFetch('/prescriptions')");
    out = out.replace("<Patients q={query} bump={bump} toast={setToast} error={setError}/>", "<Patients q={query} bump={bump} tick={tick} toast={setToast} error={setError}/>");
    out = out.replace("function Patients({q,bump,toast,error})", "function Patients({q,bump,tick,toast,error})");
    out = out.replace("},[q,bump]);const save=async v=>", "},[q,tick]);const save=async v=>");
    out = out.replace("<ArchivePage q={query} error={setError}/>", "<ArchivePage q={query} tick={tick} error={setError}/>");
    out = out.replace("function ArchivePage({q,error})", "function ArchivePage({q,tick,error})");
    out = out.replace("},[]);const list=useMemo(()=>q?rows.filter", "},[tick]);const list=useMemo(()=>q?rows.filter");
    return out === code ? null : {code: out, map: null};
  }
};

export default defineConfig({plugins:[runtimeFix,react()],build:{sourcemap:false}});
