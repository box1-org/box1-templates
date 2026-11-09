'use strict';
const { createBackendModule, coreServices } = require('@backstage/backend-plugin-api');
const { createTemplateAction } = require('@backstage/plugin-scaffolder-node');
const { scaffolderActionsExtensionPoint } = require('@backstage/plugin-scaffolder-node');
const { DefaultGithubCredentialsProvider, ScmIntegrations } = require('@backstage/integration');
const { Workflow, profileInputSchema, RESOLVE_OUTPUTS } = require('./workflow.cjs');
const {catalogServiceRef}=require('@backstage/plugin-catalog-node');
const shared = { name:{type:'string',minLength:3,maxLength:35}, owner:{type:'string'}, profile:profileInputSchema() };
function action(id, operation, config, credentials) {
  const repository = operation === 'repository';
  const output = repository ? ['remoteUrl','repoContentsUrl','commitHash'] : ['sourceUrl','catalogUrl','pipelineUrl','deploymentUrl','argoUrl','onboardingUrl','statusRecord','imageDigest'];
  return createTemplateAction({
    id, description: repository ? 'Create or resume an owned Box1 source repository' : 'Validate development onboarding, await readiness, build, promote and verify first deployment',
    schema:{input:{type:'object',additionalProperties:false,required:repository?['name','owner','description','visibility']:['name','sourceRevision'],properties:repository?{...shared,description:{type:'string',minLength:1,maxLength:120},visibility:{type:'string',enum:['private','public']}}:{name:shared.name,profile:shared.profile,sourceRevision:{type:'string',pattern:'^[a-f0-9]{40}$'}}},output:{type:'object',properties:Object.fromEntries(output.map(key=>[key,{type:'string'}]))}},
    async handler(ctx) { await new Workflow({ctx,config,credentials}).run(operation); },
  });
}
exports.default=createBackendModule({pluginId:'scaffolder',moduleId:'box1-development-onboarding',register(reg){
  reg.registerInit({deps:{actions:scaffolderActionsExtensionPoint,config:coreServices.rootConfig,catalog:catalogServiceRef},async init({actions,config,catalog}){
    const credentials=DefaultGithubCredentialsProvider.fromIntegrations(ScmIntegrations.fromConfig(config));
    actions.addActions(action('box1:repository:ensure','repository',config,credentials),
      action('box1:development:provision','provision',config,credentials),
      action('box1:development:platform','platform',config,credentials),
      action('box1:development:build','buildPhase',config,credentials),
      action('box1:development:promote','promote',config,credentials),
      action('box1:development:verify','verify',config,credentials),
      action('box1:development:onboard','delivery',config,credentials),createTemplateAction({
      id:'box1:catalog:submit',description:'Submit or reuse the owned service catalog location without waiting for processing',
      schema:{input:{type:'object',additionalProperties:false,required:['name'],properties:{name:shared.name}},output:{type:'object',properties:{entityRef:{type:'string'},catalogInfoUrl:{type:'string'}}}},
      async handler(ctx){await new Workflow({ctx,config,credentials,catalog}).run('catalogSubmit');},
    }),createTemplateAction({
      id:'box1:catalog:verify',description:'Wait for the owned service catalog entity to finish processing',
      schema:{input:{type:'object',additionalProperties:false,required:['name'],properties:{name:shared.name}},output:{type:'object',properties:{entityRef:{type:'string'},catalogInfoUrl:{type:'string'}}}},
      async handler(ctx){await new Workflow({ctx,config,credentials,catalog}).run('catalogVerify');},
    }),createTemplateAction({
      id:'box1:catalog:ensure',description:'Register or reuse the owned service catalog entry and observe processing',
      schema:{input:{type:'object',additionalProperties:false,required:['name'],properties:{name:shared.name}},output:{type:'object',properties:{entityRef:{type:'string'},catalogInfoUrl:{type:'string'}}}},
      async handler(ctx){await new Workflow({ctx,config,credentials,catalog}).run('registerCatalog');},
    }),createTemplateAction({
      // 1.5.0 (box1-docs#138): for profiles without a source repository (vm-instance).
      id:'box1:development:resolve-source',description:'Resolve the approved revision and digests of the source an instance boots, before its GitOps bundle is rendered',
      schema:{input:{type:'object',additionalProperties:false,required:['name','profile','source'],properties:{name:shared.name,profile:shared.profile,source:{type:'string',minLength:3,maxLength:40,pattern:'^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$'}}},output:{type:'object',properties:Object.fromEntries(RESOLVE_OUTPUTS.map(key=>[key,{type:'string'}]))}},
      async handler(ctx){await new Workflow({ctx,config,credentials}).run('resolveSource');},
    }));
  }});
}});
