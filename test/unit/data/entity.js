const should = require('should');
const appRoot = require('app-root-path');
const assert = require('assert');
const { ConflictType } = require('../../../lib/data/entity');
const { Entity } = require('../../../lib/model/frames');
const { parseSubmissionXml, extractEntity, validateEntity, extractSelectedProperties, selectFields, diffEntityData, getDiffProp, getWithConflictDetails } = require(appRoot + '/lib/data/entity');
const { fieldsFor } = require(appRoot + '/test/util/schema');
const testData = require(appRoot + '/test/data/xml');

describe('extracting and validating entities', () => {
  describe('validateEntity', () => {
    it('should throw errors on when label is missing', () => {
      const entity = {
        system: {
          id: '12345678-1234-4123-8234-123456789abc',
          dataset: 'foo',
        },
        data: {}
      };
      assert.throws(() => { validateEntity(entity); }, (err) => {
        err.problemCode.should.equal(400.2);
        err.message.should.equal('Required parameter label missing.');
        return true;
      });
    });

    it('should throw errors when id is missing', () => {
      (() => validateEntity({
        system: {
          label: 'foo',
          id: '  ',
          dataset: 'foo',
        },
        data: {}
      })).should.throw(/Required parameter uuid missing/);
    });

    it('should throw errors when id is not a valid uuid', () => {
      (() => validateEntity({
        system: {
          label: 'foo',
          id: 'uuid:12123123',
          dataset: 'foo',
        },
        data: {}
      })).should.throw(/Invalid input data type: expected \(uuid\) to be \(valid UUID\)/);
    });

    it('should remove create property from system', () => {
      const entity = {
        system: {
          create: '1',
          id: '12345678-1234-4123-8234-123456789abc',
          label: 'foo',
          dataset: 'foo',
        },
        data: {}
      };
      validateEntity(entity).system.should.not.have.property('create');
    });

    it('should id property with uuid and remove uuid: prefix from the value', () => {
      const entity = {
        system: {
          id: '12345678-1234-4123-8234-123456789abc',
          label: 'foo',
          dataset: 'foo',
        },
        data: {}
      };
      const validatedEntity = validateEntity(entity);

      validatedEntity.system.should.not.have.property('id');
      validatedEntity.system.should.have.property('uuid', '12345678-1234-4123-8234-123456789abc');
    });

    it('should throw error when baseVersion for update is missing', () => {
      (() => validateEntity({
        system: {
          id: '12345678-1234-4123-8234-123456789abc',
          label: 'foo',
          dataset: 'foo',
          update: '1'
        },
        data: {}
      })).should.throw(/Required parameter baseVersion missing/);
    });

    it('should throw error when baseVersion is not an integer', () => {
      (() => validateEntity({
        system: {
          id: '12345678-1234-4123-8234-123456789abc',
          label: 'foo',
          dataset: 'foo',
          update: '1',
          baseVersion: 'a'
        },
        data: {}
      })).should.throw('Invalid input data type: expected (baseVersion) to be (integer)');
    });
  });

  describe('extract entity from submission: parseSubmissionXml', () => {
    // Used to compare entity structure when Object.create(null) used.
    beforeEach(() => {
      should.config.checkProtoEql = false;
    });
    afterEach(() => {
      should.config.checkProtoEql = true;
    });

    describe('new entity', () => {
      it('should return entity data parsed from submission based on form fields', () =>
        fieldsFor(testData.forms.simpleEntity)
          .then((fields) => fields.filter((field) => field.propertyName || field.path.indexOf('/meta/entity') === 0))
          .then((fields) => parseSubmissionXml(fields, testData.instances.simpleEntity.one))
          .then((result) => {
            should(result.data).eql({ first_name: 'Alice', age: '88' });
          }));

      it('should return entity system data parsed from submission', () =>
        fieldsFor(testData.forms.simpleEntity)
          .then((fields) => fields.filter((field) => field.propertyName || field.path.indexOf('/meta/entity') === 0))
          .then((fields) => parseSubmissionXml(fields, testData.instances.simpleEntity.one))
          .then((result) => {
            should(result.system).eql({
              create: '1',
              id: 'uuid:12345678-1234-4123-8234-123456789abc',
              label: 'Alice (88)',
              dataset: 'people',
              update: undefined,
              baseVersion: undefined
            });
          }));

      it('should get entity uuid without uuid: prefix', () =>
        fieldsFor(testData.forms.simpleEntity)
          .then((fields) => fields.filter((field) => field.propertyName || field.path.indexOf('/meta/entity') === 0))
          .then((fields) => parseSubmissionXml(fields, testData.instances.simpleEntity.one.replace('uuid:', '')))
          .then((result) => {
            should(result.system).eql({
              create: '1',
              id: '12345678-1234-4123-8234-123456789abc',
              label: 'Alice (88)',
              dataset: 'people',
              update: undefined,
              baseVersion: undefined
            });
          }));

      it('should get create property of entity if create is "true"', () =>
        fieldsFor(testData.forms.simpleEntity)
          .then((fields) => fields.filter((field) => field.propertyName || field.path.indexOf('/meta/entity') === 0))
          .then((fields) => parseSubmissionXml(fields, testData.instances.simpleEntity.one.replace('create="1"', 'create="true"')))
          .then((result) => {
            result.system.create.should.equal('true');
          }));

      it('should get any value of create', () =>
        fieldsFor(testData.forms.simpleEntity)
          .then((fields) => fields.filter((field) => field.propertyName || field.path.indexOf('/meta/entity') === 0))
          .then((fields) => parseSubmissionXml(fields, testData.instances.simpleEntity.one.replace('create="1"', 'create="foo"')))
          .then((result) => {
            result.system.create.should.equal('foo');
          }));

      it('should get (but later ignore) baseVersion when it is provided with create instead of update', () =>
        fieldsFor(testData.forms.updateEntity)
          .then((fields) => fields.filter((field) => field.propertyName || field.path.indexOf('/meta/entity') === 0))
          .then((fields) => parseSubmissionXml(fields, testData.instances.updateEntity.one.replace('update="1"', 'create="1"')))
          .then((result) => {
            should.not.exist(result.system.update);
            result.system.create.should.equal('1');
            result.system.baseVersion.should.equal('1');
          }));
    });

    describe('update entity', () => {
      it('should return entity data parsed from submission based on form fields', () =>
        fieldsFor(testData.forms.updateEntity)
          .then((fields) => fields.filter((field) => field.propertyName || field.path.indexOf('/meta/entity') === 0))
          .then((fields) => parseSubmissionXml(fields, testData.instances.updateEntity.one))
          .then((result) => {
            should(result.data).eql(Object.assign(Object.create(null), { first_name: 'Alicia', age: '85' }));
          }));

      it('should return entity system data parsed from submission', () =>
        fieldsFor(testData.forms.updateEntity)
          .then((fields) => fields.filter((field) => field.propertyName || field.path.indexOf('/meta/entity') === 0))
          .then((fields) => parseSubmissionXml(fields, testData.instances.updateEntity.one))
          .then((result) => {
            should(result.system).eql({
              create: undefined,
              id: '12345678-1234-4123-8234-123456789abc',
              label: 'Alicia (85)',
              dataset: 'people',
              update: '1',
              baseVersion: '1'
            });
          }));
    });
  });

  describe('extract entity from API request: extractEntity', () => {
    // Used to compare entity structure when Object.create(null) used.
    beforeEach(() => {
      should.config.checkProtoEql = false;
    });
    afterEach(() => {
      should.config.checkProtoEql = true;
    });

    it('should reject if extra fields passed to body', () => {
      const body = {
        uuid: '12345678-1234-4123-8234-123456789abc',
        label: 'Alice (88)',
        data: { first_name: 'Alice' },
        extra: 'field'
      };
      const propertyNames = ['first_name'];
      assert.throws(() => { extractEntity(body, propertyNames); }, (err) => {
        err.problemCode.should.equal(400.31);
        err.message.should.equal('Expected parameters: (label, uuid, data). Got (uuid, label, data, extra).');
        return true;
      });
    });

    describe('new entities', () => {
      it('should parse new entity data', () => {
        const body = {
          uuid: '12345678-1234-4123-8234-123456789abc',
          label: 'Alice (88)',
          data: { age: '88', first_name: 'Alice' }
        };
        const propertyNames = ['age', 'first_name'];
        const entity = extractEntity(body, propertyNames);
        should(entity).eql({
          system: {
            label: 'Alice (88)',
            uuid: '12345678-1234-4123-8234-123456789abc'
          },
          data: { age: '88', first_name: 'Alice' }
        });
      });

      it('should parse subset of dataset properties and leave the rest undefined', () => {
        const body = {
          uuid: '12345678-1234-4123-8234-123456789abc',
          label: 'Alice (88)',
          data: { first_name: 'Alice' }
        };
        const propertyNames = ['age', 'first_name'];
        const entity = extractEntity(body, propertyNames);
        should(entity).eql({
          system: {
            label: 'Alice (88)',
            uuid: '12345678-1234-4123-8234-123456789abc'
          },
          data: { first_name: 'Alice' }
        });
      });

      it('should reject if data contains unknown properties', () => {
        const body = {
          uuid: '12345678-1234-4123-8234-123456789abc',
          label: 'Label',
          data: { age: '88', favorite_food: 'pizza' }
        };
        const propertyNames = ['age'];
        assert.throws(() => { extractEntity(body, propertyNames); }, (err) => {
          err.problemCode.should.equal(400.28);
          err.message.should.equal('The entity is invalid. You specified the dataset property [favorite_food] which does not exist.');
          return true;
        });
      });

      it('should reject if required part of the request is missing or not a string', () => {
        // These are JSON entity validation errors so they use a newer 400 bad request problem
        const requests = [
          [
            { uuid: '12345678-1234-4123-8234-123456789abc', label: 1234, data: { first_name: 'Alice' } },
            400.11,
            'Invalid input data type: expected (label) to be (string)'
          ],
          [
            { uuid: '12345678-1234-4123-8234-123456789abc' },
            400.28,
            'The entity is invalid. No entity data or label provided.'
          ],
          [
            { uuid: '12345678-1234-4123-8234-123456789abc', label: 'Label', data: { first_name: 'Alice', age: 99 } },
            400.11,
            'Invalid input data type: expected (age) to be (string)'
          ],
          [
            { uuid: '12345678-1234-4123-8234-123456789abc', label: 'Label', data: { first_name: 'Alice', age: null } },
            400.11,
            'Invalid input data type: expected (age) to be (string)'
          ],
          [
            { uuid: 123, label: 'Label', data: { first_name: 'Alice', age: 99 } },
            400.11,
            'Invalid input data type: expected (uuid) to be (string)'
          ]
        ];
        const propertyNames = ['age', 'first_name'];
        for (const [body, code, message] of requests) {
          assert.throws(() => { extractEntity(body, propertyNames); }, (err) => {
            err.problemCode.should.equal(code);
            err.message.should.match(message);
            return true;
          });
        }
      });
    });

    describe('updated entities', () => {
      it('should parse updated entity data', () => {
        const existingEntity = {
          system: {
            uuid: '12345678-1234-4123-8234-123456789abc',
            label: 'Alice (88)',
          },
          data: { age: '88', first_name: 'Alice' }
        };
        const newData = {
          data: { age: '99', first_name: 'Alice' },
          label: 'New Label'
        };
        const propertyNames = ['age', 'first_name'];
        const entity = extractEntity(newData, propertyNames, existingEntity);
        should(entity).eql({
          system: {
            label: 'New Label',
            uuid: '12345678-1234-4123-8234-123456789abc'
          },
          data: { age: '99', first_name: 'Alice' }
        });
      });

      it('should allow only label to be updated without changing data', () => {
        const existingEntity = {
          system: {
            uuid: '12345678-1234-4123-8234-123456789abc',
            label: 'Alice (88)',
          },
          data: { first_name: 'Alice' }
        };
        const body = {
          label: 'New Label'
        };
        const propertyNames = ['first_name'];
        const entity = extractEntity(body, propertyNames, existingEntity);
        should(entity).eql({
          system: {
            label: 'New Label',
            uuid: '12345678-1234-4123-8234-123456789abc'
          },
          data: { first_name: 'Alice' }
        });
      });

      it('should allow updating properties not included in earlier version of entity', () => {
        const existingEntity = {
          system: {
            uuid: '12345678-1234-4123-8234-123456789abc',
            label: 'Label',
          },
          data: { first_name: 'Alice' }
        };
        const newData = {
          data: { age: '99' }
        };
        const propertyNames = ['age', 'first_name'];
        const entity = extractEntity(newData, propertyNames, existingEntity);
        should(entity).eql({
          system: {
            label: 'Label',
            uuid: '12345678-1234-4123-8234-123456789abc'
          },
          data: { age: '99', first_name: 'Alice' }
        });
      });

      it('should reject if required part of the request is missing or not a string', () => {
        const requests = [
          [
            {},
            400.28, 'The entity is invalid. No entity data or label provided.'
          ],
          [
            { label: null },
            400.28, 'The entity is invalid. No entity data or label provided.'
          ],
          [
            { label: '' },
            400.2, 'Required parameter label missing.'
          ],
          [
            { data: { first_name: 'Alice', age: 99 } },
            400.11, 'Invalid input data type: expected (age) to be (string)'
          ],
          [
            { data: { first_name: 'Alice', age: null } },
            400.11, 'Invalid input data type: expected (age) to be (string)'
          ],
        ];
        const existingEntity = {
          system: {
            uuid: '12345678-1234-4123-8234-123456789abc',
            label: 'Alice (88)',
          },
          data: { first_name: 'Alice' }
        };
        const propertyNames = ['age', 'first_name'];
        for (const [body, errorCode, message] of requests) {
          assert.throws(() => { extractEntity(body, propertyNames, existingEntity); }, (err) => {
            err.problemCode.should.equal(errorCode);
            err.message.should.match(message);
            return true;
          });
        }
      });
    });
  });

  describe('extractSelectedProperties', () => {
    const properties = [{ name: 'property1' }, { name: 'property2' }];

    it('returns null if query.$select is not present', () => {
      const query = {};
      const result = extractSelectedProperties(query, properties);
      should(result).be.null();
    });

    it('returns null if query.$select is equal to *', () => {
      const query = { $select: '*' };
      const result = extractSelectedProperties(query, properties);
      should(result).be.null();
    });

    it('throws error if a selected property is not a valid property', () => {
      const query = { $select: 'property1, property2, unknown_property' };
      (() => {
        extractSelectedProperties(query, properties);
      }).should.throw('Could not find a property named \'unknown_property\'');
    });

    it('throws error if an invalid system property is $selected', () => {
      const query = { $select: 'property1, property2, __system/unknown_property' };
      (() => {
        extractSelectedProperties(query, properties);
      }).should.throw('Could not find a property named \'__system/unknown_property\'');
    });

    it('returns set of selected properties if they are all valid', () => {
      const query = { $select: '__id, __system/createdAt, property1' };
      const result = extractSelectedProperties(query, properties);
      result.should.be.eql(new Set(['__id', '__system/createdAt', 'property1']));
    });

    it('returns all properties', () => {
      const query = { $select: '__id, __system, property1, property2' };
      const result = extractSelectedProperties(query, properties);
      result.should.be.eql(new Set(['__id', '__system', 'property1', 'property2']));
    });

  });

  describe('selectFields', () => {
    const entity = {
      uuid: 'uuid',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
      conflict: 'hard',
      def: {
        label: 'label',
        version: 1,
        data: {
          firstName: 'John',
          lastName: 'Doe'
        }
      },
      aux: {
        creator: {
          id: 'id',
          displayName: 'displayName'
        },
        stats: {
          updates: 0
        }
      }
    };
    const properties = [{ name: 'firstName' }, { name: 'lastName' }];

    it('selects all properties', () => {
      const selectedProperties = null;
      const result = selectFields(entity, properties, selectedProperties);
      result.should.be.eql({
        __id: 'uuid',
        label: 'label',
        __system: {
          createdAt: 'createdAt',
          creatorId: 'id',
          creatorName: 'displayName',
          updatedAt: 'updatedAt',
          updates: 0,
          version: 1,
          conflict: 'hard'
        },
        firstName: entity.def.data.firstName,
        lastName: entity.def.data.lastName
      });
    });

    it('selects only specified properties', () => {
      const selectedProperties = new Set(['__id', 'label', 'firstName']);
      const result = selectFields(entity, properties, selectedProperties);
      result.should.be.eql({
        __id: 'uuid',
        label: 'label',
        firstName: entity.def.data.firstName
      });
    });

    it('selects only specified system properties', () => {
      const selectedProperties = new Set(['__id', 'label', '__system/createdAt']);
      const result = selectFields(entity, properties, selectedProperties);
      result.should.be.eql({
        __id: 'uuid',
        label: 'label',
        __system: {
          createdAt: 'createdAt'
        }
      });
    });

    it('selects all system properties', () => {
      const selectedProperties = new Set(['__id', 'label', '__system']);
      const result = selectFields(entity, properties, selectedProperties);
      result.should.be.eql({
        __id: 'uuid',
        label: 'label',
        __system: {
          createdAt: 'createdAt',
          creatorId: 'id',
          creatorName: 'displayName',
          updatedAt: 'updatedAt',
          updates: 0,
          version: 1,
          conflict: 'hard'
        }
      });
    });

    it('should return all properties even if entity object does not have all of them', () => {
      const data = {
        uuid: 'uuid',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
        conflict: 'hard',
        def: {
          label: 'label',
          version: 1,
          data: {}
        },
        aux: {
          creator: {
            id: 'id',
            displayName: 'displayName'
          },
          stats: {
            updates: 0
          }
        }
      };
      const selectedProperties = null;
      const result = selectFields(data, properties, selectedProperties);
      result.should.be.eql({
        __id: 'uuid',
        label: 'label',
        __system: {
          createdAt: 'createdAt',
          creatorId: 'id',
          creatorName: 'displayName',
          updatedAt: 'updatedAt',
          updates: 0,
          version: 1,
          conflict: 'hard'
        },
        firstName: '',
        lastName: ''
      });
    });

    it('should sanitize property names', () => {
      entity.def.data['date.of.birth'] = '2023-01-01';
      properties.push({ name: 'date.of.birth' });
      const selectedProperties = null;
      const result = selectFields(entity, properties, selectedProperties);
      result.should.be.eql({
        __id: 'uuid',
        label: 'label',
        __system: {
          createdAt: 'createdAt',
          creatorId: 'id',
          creatorName: 'displayName',
          updatedAt: 'updatedAt',
          updates: 0,
          version: 1,
          conflict: 'hard'
        },
        firstName: entity.def.data.firstName,
        lastName: entity.def.data.lastName,
        date_of_birth: entity.def.data['date.of.birth']
      });
    });
  });

  describe('diffEntityData', () => {

    it('should return an array of empty arrays when given an array of identical entities', () => {
      const defs = [
        { name: 'John', age: '12' },
        { name: 'John', age: '12' },
        { name: 'John', age: '12' }
      ];

      const result = diffEntityData(defs);

      result.forEach(diff => diff.should.be.an.Array().and.be.empty());
    });

    it('should return an empty array when given an array with one or fewer elements', () => {
      const emptyDefs = [];
      const singleDef = [{ name: 'John', age: '12' }];

      const emptyResult = diffEntityData(emptyDefs);
      const singleResult = diffEntityData(singleDef);

      emptyResult.should.be.an.Array().and.be.empty();
      singleResult.should.be.an.Array().and.be.empty();
    });

    it('should return the diff', () => {
      const defs = [
        { name: 'John', age: '12' },
        { name: 'Jane', age: '12', city: 'Toronto' },
        { name: 'Robert', age: '12', city: 'Boston' },
        { name: 'Robert', age: '', city: '', sex: 'male' },
      ];

      const expectedOutput = [
        [
          { old: 'John', new: 'Jane', propertyName: 'name' },
          { old: undefined, new: 'Toronto', propertyName: 'city' }
        ],
        [
          { old: 'Jane', new: 'Robert', propertyName: 'name' },
          { old: 'Toronto', new: 'Boston', propertyName: 'city' }
        ],
        [
          { old: '12', new: '', propertyName: 'age' },
          { old: 'Boston', new: '', propertyName: 'city' },
          { old: undefined, new: 'male', propertyName: 'sex' }
        ]
      ];

      diffEntityData(defs).should.be.eql(expectedOutput);

    });
  });

  describe('getDiffProp', () => {

    it('should return list of different properties', () => {
      getDiffProp({ name: 'John', age: '22', hometown: 'Boston' }, { name: 'Jane', age: '22', hometown: 'Boston' })
        .should.eql(['name']);
    });

    it('should include properties not in 2nd argument', () => {
      getDiffProp({ name: 'John', age: '22', gender: 'male' }, { name: 'Jane', age: '22', hometown: 'Boston' })
        .should.eql(['name', 'gender']);
    });
  });

  describe('getWithConflictDetails', () => {

    it('should fill in correct information for SOFT conflict', () => {
      const defs = [
        new Entity.Def({ id: 0, version: 1, label: 'John', data: { name: 'John', age: '88' }, dataReceived: { name: 'John', age: '88' }, conflictingProp: null, baseVersion: null }),
        new Entity.Def({ id: 0, version: 2, label: 'Jane', data: { name: 'Jane', age: '88' }, dataReceived: { label: 'Jane', name: 'Jane' }, conflictingProp: [], baseVersion: 1 }),
        new Entity.Def({ id: 0, version: 3, label: 'Jane', data: { name: 'Jane', age: '99' }, dataReceived: { age: '99' }, conflictingProp: [], baseVersion: 1 })
      ];

      const audits = [{ action: 'entity.create', details: { entityDefId: 0 } }];

      const result = getWithConflictDetails(defs, audits, false);

      result[2].conflict.should.be.eql(ConflictType.SOFT);
      result[2].baseDiff.should.be.eql(['age']);
      result[2].serverDiff.should.be.eql(['age']);
    });

    it('should fill in correct information for HARD conflict', () => {
      const defs = [
        new Entity.Def({ id: 0, version: 1, label: 'John', data: { name: 'John', age: '88' }, dataReceived: { name: 'John', age: '88' }, conflictingProperties: null, baseVersion: null }),
        new Entity.Def({ id: 0, version: 2, label: 'Jane', data: { name: 'Jane', age: '77' }, dataReceived: { label: 'Jane', name: 'Jane', age: '77' }, conflictingProperties: [], baseVersion: 1 }),
        new Entity.Def({ id: 0, version: 3, label: 'Jane', data: { name: 'Jane', age: '99' }, dataReceived: { age: '99' }, conflictingProperties: ['age'], baseVersion: 1 })
      ];

      const audits = [{ action: 'entity.create', details: { entityDefId: 0 } }];

      const result = getWithConflictDetails(defs, audits, false);

      result[2].conflict.should.be.eql(ConflictType.HARD);
      result[2].baseDiff.should.be.eql(['age']);
      result[2].serverDiff.should.be.eql(['age']);
    });

    it('should return only relevant versions', () => {
      const defs = [
        new Entity.Def({ id: 0, version: 1, label: 'John', data: { name: 'John', age: '88' }, dataReceived: { name: 'John', age: '88' }, conflictingProp: null, baseVersion: null }),
        new Entity.Def({ id: 0, version: 2, label: 'Robert', data: { name: 'Robert', age: '20' }, dataReceived: { label: 'Robert', name: 'Robert', age: '20' }, conflictingProp: null, baseVersion: 1 }),
        new Entity.Def({ id: 0, version: 3, label: 'Jane', data: { name: 'Jane', age: '20' }, dataReceived: { label: 'Jane', name: 'Jane' }, conflictingProp: [], baseVersion: 2 }),
        new Entity.Def({ id: 0, version: 4, label: 'Jane', data: { name: 'Jane', age: '99' }, dataReceived: { age: '99' }, conflictingProp: [], baseVersion: 2 }),
        new Entity.Def({ id: 0, version: 5, label: 'Jane', data: { name: 'Jane', age: '10' }, dataReceived: { age: '10' }, conflictingProp: [], baseVersion: 3 }),
      ];

      const audits = [{ action: 'entity.create', details: { entityDefId: 0 } }];

      const result = getWithConflictDetails(defs, audits, true);

      result.map(v => v.version).should.eql([2, 3, 4, 5]);
    });
  });
});
