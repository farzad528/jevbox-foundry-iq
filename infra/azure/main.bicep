targetScope = 'resourceGroup'

@description('Explicitly approved region; do not substitute another region.')
param location string
param searchName string
param foundryName string
param projectName string
param owner string
@allowed(['basic', 'standard'])
param searchSku string
@minValue(1)
@maxValue(3)
param searchReplicas int
@description('New isolated public endpoint profile, separately approved for the local PoC.')
@allowed(['Enabled'])
param publicNetworkAccess string
@description('Model deployments with explicit name, model name/version, SKU and approved capacity.')
param modelDeployments array
@description('Verified built-in Search Index Data Reader role GUID, never a contributor role.')
@allowed(['1407120a-92aa-4202-b7e9-c0e197c71c8f'])
param searchReaderRoleId string
@description('Distinct, approved runtime reader and ingestion service principals.')
param queryPrincipalId string
param ingestionPrincipalId string
@allowed(['8ebe5a00-799e-43f5-93ac-243d3dce84a7'])
param searchWriterRoleId string
@description('Verified Cognitive Services User role GUID for Search MI model access.')
@allowed(['a97b65f3-24c7-4388-baec-2e87135dc908'])
param searchModelRoleId string
@description('Separate local project API model/answer/wiki/embedding caller; not the Search ingestion identity.')
param projectModelPrincipalId string


var tags = { owner: owner, purpose: 'jevbox-foundry-iq-synthetic-poc' }

resource search 'Microsoft.Search/searchServices@2025-05-01' = {
  name: searchName
  location: location
  tags: tags
  sku: { name: searchSku }
  identity: { type: 'SystemAssigned' }
  properties: {
    disableLocalAuth: true
    replicaCount: searchReplicas
    partitionCount: 1
    semanticSearch: 'standard'
    publicNetworkAccess: toLower(publicNetworkAccess)
  }
}
resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: foundryName
  location: location
  kind: 'AIServices'
  tags: tags
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: foundryName
    allowProjectManagement: true
    disableLocalAuth: true
    publicNetworkAccess: publicNetworkAccess
  }
}
resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundry
  name: projectName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: { displayName: projectName, description: 'Synthetic knowledge-drive PoC' }
}
resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2025-06-01' = [for deployment in modelDeployments: {
  parent: foundry
  name: deployment.name
  sku: { name: deployment.sku, capacity: deployment.capacity }
  properties: {
    model: { format: 'OpenAI', name: deployment.model, version: deployment.version }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}]
resource projectReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, project.id, searchReaderRoleId)
  scope: search
  properties: {
    principalId: project.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchReaderRoleId)
  }
}
resource appReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, queryPrincipalId, searchReaderRoleId)
  scope: search
  properties: {
    principalId: queryPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchReaderRoleId)
  }
}
resource ingestionWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(search.id, ingestionPrincipalId, searchWriterRoleId)
  scope: search
  properties: {
    principalId: ingestionPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchWriterRoleId)
  }
}
resource searchModelAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, search.id, searchModelRoleId)
  scope: foundry
  properties: {
    principalId: search.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', searchModelRoleId)
  }
}
resource localProjectAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(project.id, projectModelPrincipalId, '53ca6127-db72-4b80-b1b0-d745d6d5456d')
  scope: project
  properties: {
    principalId: projectModelPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
  }
}

output searchResourceId string = search.id
output searchEndpoint string = 'https://${search.name}.search.windows.net'
output foundryResourceId string = foundry.id
output projectResourceId string = project.id
output projectPrincipalId string = project.identity.principalId
output projectEndpoint string = 'https://${foundry.name}.services.ai.azure.com/api/projects/${project.name}'
