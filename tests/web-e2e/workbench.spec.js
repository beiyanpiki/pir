import { test, expect } from "@playwright/test";
const project = "a".repeat(64), runA = "overview-a", runB = "overview-b";
const summary = (id, mode = "change") => ({runId:id, mode, base:"a".repeat(40), head:"b".repeat(40), startedAt:1, finishedAt:2,status:"completed",rounds:1,candidates:60,confirmed:60,rejected:0,uncertain:0,notes:null,model:null,verifierModel:null,runVerdict:"correct-with-findings",incomplete:false,stoppedBecause:"done",lastUpdatedAt:2,durationMs:1,totalTokens:null,cost:null,transcriptsAvailable:true});
const finding = (n) => ({id:`f${n}`,displayId:`F-${n}`,title:`Finding ${n}`,category:"logic",severity:"P2",status:"confirmed",round:1,createdAt:n,evidenceCount:1,confidence:.8});
test.beforeEach(async ({page})=>{
 await page.route("**/api/**", async route=>{
  const url=new URL(route.request().url()), parts=url.pathname.split('/');
  if(url.pathname==='/api/overview') return route.fulfill({json:{projects:[{projectId:project,name:"Workbench fixture",runsTotal:2,openFindings:60}],active:[]}});
  if(url.pathname.endsWith('/coverage')) return route.fulfill({json:parts[4]===runB?{mode:'audit',available:true,summary:{filesInScope:2,filesReviewed:1,filesPartial:0,filesUnreviewed:0,filesBlocked:1,filesFailed:0,batchesTotal:2,batchesCompleted:1},units:[],files:[{path:'src/blocked.ts',state:'blocked',rangesReviewed:0,rangesTotal:1,reason:'budget reached'}],target:null}:{mode:'change',available:false,reason:'not-recorded'}});
  if(parts[5]==='findings') return route.fulfill({json:{...finding(Number(parts[6].slice(1))),claim:'Verified claim for current run',trigger:'Calling affected path',anchors:[{path:'src/example.ts',startLine:8}],evidence:[{kind:'code',excerpt:'const x = 1',description:'Source bound'}],verifierRationale:'Reproduced',relatedSessions:[{sessionKey:'persisted:reviewer-r1.json',relation:'candidate'}]}});
  if(parts[5]==='transcript') return route.fulfill({json:{role:'reviewer',model:null,prompt:'Review fixture',messages:[{role:'assistant',content:'Session source fixture'}]}});
  if(parts[2]==='runs') return route.fulfill({json:{run:summary(parts[4],parts[4]===runB?'audit':'change'),findings:{items:Array.from({length:60},(_,i)=>finding(i+1)),total:60},sessions:[{file:'reviewer-r1.json',sessionKind:'reviewer',round:1}],manifest:{schemaVersion:1,incomplete:false,runVerdict:'correct-with-findings',rounds:[],sessions:[]},transcriptsAvailable:true}});
  return route.fulfill({json:{runs:[],total:0}});
 });
});
test('Overview is the main default panel with five keyboard tabs and unknown coverage',async({page})=>{
 await page.goto(`/runs/${project}/${runA}`);
 await expect(page.getByRole('tab',{name:'Overview',exact:true})).toHaveAttribute('aria-selected','true');
 await expect(page.getByRole('tabpanel')).toContainText('confirmed findings below');
 await expect(page.getByRole('tabpanel')).toContainText('Coverage not recorded');
 await page.getByRole('tab',{name:'Overview',exact:true}).focus(); await page.keyboard.press('End');
 await expect(page.getByRole('tab',{name:'Details',exact:true})).toBeFocused();
 await page.keyboard.press('Home'); await expect(page.getByRole('tab',{name:'Overview',exact:true})).toBeFocused();
});
test('finding beyond the first 50 opens its evidence drawer and links to source session',async({page})=>{
 await page.setViewportSize({width:1100,height:800});
 await page.goto(`/runs/${project}/${runA}?tab=findings&finding=F-60`);
 const dialog=page.getByRole('dialog',{name:'Review inspector'}); await expect(dialog).toBeVisible();
 await expect(dialog).toContainText('F-60'); await expect(dialog).toContainText('Verified claim');
 await dialog.getByRole('link',{name:/candidate/}).click();
 await expect(page).toHaveURL(/tab=workflow/); await page.keyboard.press('Escape');
 await expect(page.getByRole('tabpanel')).toContainText('Session source fixture');
 await page.goBack(); await expect(page).toHaveURL(/finding=F-60/);
});
test('coverage follows audit/change resource and main body expands with inspector closed',async({page})=>{
 await page.setViewportSize({width:1440,height:900});
 await page.goto(`/runs/${project}/${runB}?tab=coverage`); await expect(page.getByRole('tabpanel')).toContainText('Audit coverage'); await expect(page.getByRole('tabpanel')).toContainText('blocked');
 await page.goto(`/runs/${project}/${runA}?tab=coverage`); await expect(page.getByRole('tabpanel')).toContainText('Coverage not recorded');
 const before=await page.locator('.run-primary').boundingBox(); await page.getByRole('button',{name:'Open inspector'}).click();
 const after=await page.locator('.run-primary').boundingBox(); expect(before.width-after.width).toBeGreaterThan(300);
 await page.getByRole('button',{name:'Close inspector'}).first().click(); await expect.poll(async()=> (await page.locator('.run-primary').boundingBox()).width).toBe(before.width);
});
