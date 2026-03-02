const routes = { '/': 'home', '/about': 'about', '/contact': 'contact' };
function init() { console.log('Router initialized with', Object.keys(routes).length, 'routes'); }
module.exports = { routes, init, router: { init } };
