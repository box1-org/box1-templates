'use strict';
const { createBackendModule, coreServices } = require('@backstage/backend-plugin-api');
const { createTemplateAction } = require('@backstage/plugin-scaffolder-node');
const { scaffolderActionsExtensionPoint } = require('@backstage/plugin-scaffolder-node');
const { DefaultGithubCredentialsProvider, ScmIntegrations } = require('@backstage/integration');
const { Workflow } = require('./workflow.cjs');
const {catalogServiceRef}=require('@backstage/plugin-catalog-node');
const shared = { name:{type:'string',minLength:3,maxLength:35}, owner:{type:'string'} };
function action(id, operation, config, credentials) {
  const repository = operation === 'repository';
  const output = repository ? ['remoteUrl','repoContentsUrl','commitHash'] : ['sourceUrl','catalogUrl','pipelineUrl','deploymentUrl','argoUrl','onboardingUrl','statusRecord','imageDigest'];
  return createTemplateAction({
    id, description: repository ? 'Create or resume an owned Box1 source repository' : 'Validate development onboarding, await readiness, build, promote and verify first deployment',
    schema:{input:{type:'object',additionalProperties:false,required:repository?['name','owner','description','visibility']:['name','sourceRevision'],properties:repository?{...shared,description:{type:'string',minLength:1,maxLength:120},visibility:{type:'string',enum:['private','public']}}:{name:shared.name,sourceRevision:{type:'string',pattern:'^[a-f0-9]{40}$'}}},output:{type:'object',properties:Object.fromEntries(output.map(key=>[key,{type:'string'}]))}},
    async handler(ctx) { await new Workflow({ctx,config,credentials}).run(operation); },
  });
}
exports.default=createBackendModule({pluginId:'scaffolder',moduleId:'box1-development-onboarding',register(reg){
  reg.registerInit({deps:{actions:scaffolderActionsExtensionPoint,config:coreServices.rootConfig,catalog:catalogServiceRef},async init({actions,config,catalog}){
    const credentials=DefaultGithubCredentialsProvider.fromIntegrations(ScmIntegrations.fromConfig(config));
    actions.addActions(action('box1:repository:ensure','repository',config,credentials),action('box1:development:onboard','delivery',config,credentials),createTemplateAction({
      id:'box1:catalog:ensure',description:'Register or reuse the owned service catalog entry and observe processing',
      schema:{input:{type:'object',additionalProperties:false,required:['name'],properties:{name:shared.name}},output:{type:'object',properties:{entityRef:{type:'string'},catalogInfoUrl:{type:'string'}}}},
      async handler(ctx){await new Workflow({ctx,config,credentials,catalog}).run('registerCatalog');},
    }));
  }});
}});
