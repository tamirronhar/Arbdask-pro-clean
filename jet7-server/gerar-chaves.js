const c=require('crypto');
console.log('ACCESS_TOKEN='+c.randomBytes(24).toString('hex'));
console.log('MASTER_KEY='+c.randomBytes(32).toString('hex'));
