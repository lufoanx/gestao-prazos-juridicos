import test from "node:test";import assert from "node:assert/strict";import {canReadDeadline,canJoinOffice} from "../src/lib/access.mjs";
const member={userId:"u1",officeId:"o1",permissions:["deadline.read"],visibility:"assigned"};
test("prazo pessoal não fica visível ao escritório",()=>{assert.equal(canReadDeadline("u2",member,{scope:{kind:"personal",ownerId:"u1"}}),false)});
test("proprietário mantém acesso pessoal",()=>assert.equal(canReadDeadline("u1",member,{scope:{kind:"personal",ownerId:"u1"}}),true));
test("não acessa outro escritório",()=>assert.equal(canReadDeadline("u1",member,{scope:{kind:"office",officeId:"o2"},responsibleId:"u1"}),false));
test("visibilidade atribuídos limita acesso",()=>assert.equal(canReadDeadline("u1",member,{scope:{kind:"office",officeId:"o1"},responsibleId:"u2"}),false));
test("não ingressa em dois escritórios",()=>{assert.equal(canJoinOffice(member),false);assert.equal(canJoinOffice(null),true)});

