const { router } = require('./router');
const { logger } = require('./logger');
logger.info('App started');
router.init();
