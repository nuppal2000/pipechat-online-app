'use strict';

const fs=require('node:fs/promises'),path=require('node:path');
const Persona=require('./agent-persona');

// Local development only; hosted assignments use authenticated Supabase RPCs.
function localStore(file,lock,readCrm) {
  return {
    async readAgentProfile(){try{return Persona.validate(JSON.parse(await fs.readFile(file,'utf8')));}catch(error){if(error.code==='ENOENT')return null;throw error;}},
    async saveAgentProfile(assignment,expectedUpdatedAt){
      return lock(async()=>{
        const current=await readCrm(),value=Persona.validate(assignment);
        if(current.updatedAt!==expectedUpdatedAt){const error=new Error('The workspace changed. Reload before continuing.');error.status=409;throw error;}
        if(current.tableSchema?.status==='ready'&&!Persona.matches(value,current.tableSchema))throw new Error('Persona business context does not match this workspace.');
        const saved=await this.readAgentProfile();
        if(Persona.matches(saved,value)&&saved.source!=='fallback')return saved;
        await fs.mkdir(path.dirname(file),{recursive:true});
        await fs.writeFile(file+'.tmp',JSON.stringify(value));await fs.rename(file+'.tmp',file);return value;
      });
    },
    async reset(){await fs.rm(file,{force:true});}
  };
}
module.exports={localStore};
